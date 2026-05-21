import Stripe from "stripe"
import type {
  InvoiceProvider,
  NormalizedInvoice,
  ParsedWebhookEvent,
  ProviderCredentials,
} from "./types"

let _stripe: Stripe | undefined
function getStripe(): Stripe {
  return _stripe ?? (_stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-04-22.dahlia" }))
}

function normalizeStripeInvoice(invoice: Stripe.Invoice): NormalizedInvoice {
  const customer = invoice.customer as Stripe.Customer | null
  return {
    externalId: invoice.id!,
    provider: "stripe",
    clientEmail:
      invoice.customer_email ??
      (typeof customer === "object" ? customer?.email ?? "" : ""),
    clientName:
      invoice.customer_name ??
      (typeof customer === "object" ? customer?.name ?? "Client" : "Client"),
    amountDue: invoice.amount_due,
    currency: invoice.currency,
    dueDate: new Date((invoice.due_date ?? invoice.created) * 1000),
    paymentUrl: invoice.hosted_invoice_url ?? undefined,
    invoiceNumber: invoice.number ?? undefined,
  }
}

export class StripeInvoiceProvider implements InvoiceProvider {
  async getOverdueInvoices(
    credentials: ProviderCredentials
  ): Promise<NormalizedInvoice[]> {
    const accountId = credentials.stripeConnectAccountId
    if (!accountId) return []

    const invoices = await getStripe().invoices.list(
      { status: "open", limit: 100 },
      { stripeAccount: accountId }
    )

    const now = Date.now()
    return invoices.data
      .filter(
        (inv) =>
          inv.due_date !== null && inv.due_date * 1000 < now
      )
      .map(normalizeStripeInvoice)
  }

  async getInvoiceDetails(
    credentials: ProviderCredentials,
    externalId: string
  ): Promise<NormalizedInvoice | null> {
    const accountId = credentials.stripeConnectAccountId
    if (!accountId) return null

    try {
      const invoice = await getStripe().invoices.retrieve(
        externalId,
        undefined,
        { stripeAccount: accountId }
      )
      return normalizeStripeInvoice(invoice)
    } catch {
      return null
    }
  }

  verifyWebhookSignature(
    payload: string,
    headers: Record<string, string>,
    secret: string
  ): boolean {
    try {
      getStripe().webhooks.constructEvent(
        payload,
        headers["stripe-signature"] ?? "",
        secret
      )
      return true
    } catch {
      return false
    }
  }

  parseWebhookEvent(payload: string): ParsedWebhookEvent {
    const event = JSON.parse(payload) as Stripe.Event

    if (event.type === "invoice.overdue") {
      const invoice = event.data.object as Stripe.Invoice
      return {
        type: "invoice.overdue",
        invoice: normalizeStripeInvoice(invoice),
        externalId: invoice.id ?? undefined,
        connectedAccountId:
          (event as Stripe.Event & { account?: string }).account ?? undefined,
      }
    }

    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice
      return {
        type: "invoice.paid",
        externalId: invoice.id ?? undefined,
        connectedAccountId:
          (event as Stripe.Event & { account?: string }).account ?? undefined,
      }
    }

    return { type: "unknown" }
  }
}
