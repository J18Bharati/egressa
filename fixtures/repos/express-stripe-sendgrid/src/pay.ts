import sgMail from '@sendgrid/mail';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_KEY as string);

export async function charge(customerEmail: string, amount: number) {
  const intent = await stripe.paymentIntents.create({ amount, currency: 'eur' });
  await fetch(`https://api.stripe.com/v1/payment_intents/${intent.id}`);
  await sgMail.send({
    to: customerEmail,
    from: 'billing@example.com',
    subject: 'Receipt',
    text: 'ok',
  });
  return intent;
}
