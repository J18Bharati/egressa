// The stack a solo developer building with an AI agent actually ends up with.
// Every vendor here has a knowledge base entry, and they deliberately span
// four different exposure rules rather than all landing on one.
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import posthog from 'posthog-js';

// EU Cloud, chosen explicitly: a resolvable host that is not the SDK default.
posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
  api_host: 'https://eu.i.posthog.com',
});

// Region is in the project URL, so this is a static chunk the resolver reads.
export const db = createClient('https://abcdefghij.supabase.co', process.env.SUPABASE_ANON_KEY);

// No baseURL passed, so the SDK default applies. Dependency signal only.
export const claude = new Anthropic();

export async function chargeAndLog(customerEmail: string) {
  const charge = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    body: new URLSearchParams({ amount: '1000', currency: 'eur' }),
  });

  // Clerk's frontend API, on the vendor's own domain.
  await fetch('https://clerk.acme.internal/v1/client', { method: 'GET' });

  return { charge, customerEmail };
}
