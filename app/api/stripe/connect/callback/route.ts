import { createClient } from "@/lib/supabase/server"
import { prisma } from "@/lib/prisma"
import { NextResponse } from "next/server"
import Stripe from "stripe"

export async function GET(request: Request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2026-04-22.dahlia",
  })
  const { searchParams } = new URL(request.url)
  const code = searchParams.get("code")
  const state = searchParams.get("state") // should match user.id
  const error = searchParams.get("error")

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!

  if (error) {
    return NextResponse.redirect(
      `${appUrl}/dashboard/settings/stripe?error=connect_cancelled`
    )
  }

  if (!code) {
    return NextResponse.redirect(
      `${appUrl}/dashboard/settings/stripe?error=missing_code`
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || user.id !== state) {
    return NextResponse.redirect(`${appUrl}/sign-in`)
  }

  // Exchange code for access token
  const response = await stripe.oauth.token({
    grant_type: "authorization_code",
    code,
  })

  const stripeConnectAccountId = response.stripe_user_id
  if (!stripeConnectAccountId) {
    return NextResponse.redirect(
      `${appUrl}/dashboard/settings/stripe?error=no_account_id`
    )
  }

  // Upsert the connection
  await prisma.invoiceConnection.upsert({
    where: {
      // We use the userId + provider combination; use a findFirst + create/update
      // since there's no unique constraint on (userId, provider) in schema.
      // Fall back to create if not found.
      id: (
        await prisma.invoiceConnection.findFirst({
          where: { userId: user.id, provider: "stripe" },
          select: { id: true },
        })
      )?.id ?? "NEW",
    },
    create: {
      userId: user.id,
      provider: "stripe",
      stripeConnectAccountId,
      isActive: true,
    },
    update: {
      stripeConnectAccountId,
      isActive: true,
    },
  })

  return NextResponse.redirect(
    `${appUrl}/dashboard/settings/stripe?success=connected`
  )
}
