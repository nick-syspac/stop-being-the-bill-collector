import { Resend } from "resend"
import { prisma } from "@/lib/prisma"
import { renderTemplate, buildTemplateVars } from "./templates"
import type { TrackedInvoice } from "@/lib/generated/prisma/client"

let _resend: Resend | undefined
function getResend(): Resend {
  return _resend ?? (_resend = new Resend(process.env.RESEND_API_KEY!))
}

/**
 * Resolve the "From" address for a user.
 * Pro users with a verified email use their own address.
 * Free users (or unverified Pro) use the system domain.
 */
export async function resolveFromAddress(userId: string): Promise<{
  from: string
  replyTo?: string
}> {
  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: { subscriptionTier: true },
  })

  if (profile?.subscriptionTier === "pro") {
    const settings = await prisma.emailSettings.findUnique({
      where: { userId },
    })
    if (settings?.fromEmail && settings.resendVerified) {
      const name = settings.fromName ?? settings.fromEmail
      return {
        from: `${name} <${settings.fromEmail}>`,
        replyTo: settings.replyTo ?? settings.fromEmail,
      }
    }
  }

  // Fallback: system domain
  return {
    from: `${process.env.RESEND_FROM_NAME!} <${process.env.RESEND_FROM_EMAIL!}>`,
  }
}

/**
 * Send a follow-up email for a tracked invoice at the given stage.
 * Logs the send to email_logs. Returns the Resend message ID on success.
 */
export async function sendFollowUpEmail(
  invoice: TrackedInvoice,
  stage: 1 | 2 | 3,
  freelancerEmail: string,
  freelancerName: string
): Promise<string | null> {
  const { from, replyTo } = await resolveFromAddress(invoice.userId)

  // Fetch the latest invoice details (payment URL) from provider if we have it
  // For now use what we have stored
  const vars = buildTemplateVars({
    clientName: invoice.clientName,
    amountDue: invoice.amountDue,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    freelancerName,
    paymentUrl: undefined, // TODO: enrich from provider.getInvoiceDetails if needed
  })

  const { subject, html, text } = renderTemplate(stage, vars)

  try {
    const result = await getResend().emails.send({
      from,
      to: invoice.clientEmail,
      replyTo,
      subject,
      html,
      text,
    })

    const messageId = result.data?.id ?? null

    await prisma.emailLog.create({
      data: {
        trackedInvoiceId: invoice.id,
        stage,
        resendMessageId: messageId,
        fromAddress: from,
        subject,
      },
    })

    return messageId
  } catch (err) {
    console.error(`Failed to send email for invoice ${invoice.id} stage ${stage}:`, err)
    return null
  }
}
