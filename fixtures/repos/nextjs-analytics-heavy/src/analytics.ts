import * as Sentry from '@sentry/nextjs';
import OpenAI from 'openai';

const client = new OpenAI();

export function track(event: string) {
  navigator.sendBeacon('https://www.google-analytics.com/g/collect', event);
  fetch('https://o4507.ingest.sentry.io/api/1/envelope/', { method: 'POST' });
}

export async function summarise(text: string) {
  await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' });
  return client;
}
