import { prisma } from "@/lib/prisma"
import { NextResponse } from "next/server"
import Stripe from "stripe"

// Must use raw body for Stripe signature verification
export async function POST(request: Request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2026-04-22.dahlia",
  })
  const payload = await request.text()
  const signature = request.headers.get("stripe-signature") ?? ""

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_BILLING_WEBHOOK_SECRET!
    )
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.userId
      if (userId && session.subscription) {
        await prisma.userProfile.update({
          where: { userId },
          data: {
            subscriptionTier: "pro",
            subscriptionStatus: "active",
            stripeCustomerId: session.customer as string,
          },
        })
      }
      break
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription
      const profile = await prisma.userProfile.findFirst({
        where: { stripeCustomerId: subscription.customer as string },
      })
      if (profile) {
        const tier =
          subscription.status === "active" || subscription.status === "trialing"
            ? "pro"
            : "free"
        await prisma.userProfile.update({
          where: { userId: profile.userId },
          data: {
            subscriptionTier: tier,
            subscriptionStatus: subscription.status,
          },
        })
      }
      break
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription
      const profile = await prisma.userProfile.findFirst({
        where: { stripeCustomerId: subscription.customer as string },
      })
      if (profile) {
        // Revert to free tier
        await prisma.userProfile.update({
          where: { userId: profile.userId },
          data: { subscriptionTier: "free", subscriptionStatus: "cancelled" },
        })

        // Pause invoices over the free tier limit (keep first 3 by nextEmailAt)
        const activeInvoices = await prisma.trackedInvoice.findMany({
          where: {
            userId: profile.userId,
            status: { in: ["pending", "snoozed"] },
          },
          orderBy: { nextEmailAt: "asc" },
        })

        const toKeep = activeInvoices.slice(0, 3).map((i: { id: string }) => i.id)
        const toPause = activeInvoices
          .slice(3)
          .map((i: { id: string }) => i.id)

        if (toPause.length > 0) {
          await prisma.trackedInvoice.updateMany({
            where: { id: { in: toPause } },
            data: { status: "paused" },
          })
        }
        void toKeep // suppress unused warning
      }
      break
    }
  }

  return NextResponse.json({ received: true })
}
