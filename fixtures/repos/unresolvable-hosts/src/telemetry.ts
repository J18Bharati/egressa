const ANALYTICS = process.env.ANALYTICS_URL;

export async function report(event: string) {
  await fetch(ANALYTICS, { method: 'POST', body: event });
  await fetch(`https://${process.env.REGION}.metrics.example.com/v1`);
  await fetch(`${globalThis.__BASE__}/collect`);
}
