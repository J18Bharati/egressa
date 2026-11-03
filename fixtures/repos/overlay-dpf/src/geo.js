export async function locate(ip) {
  const res = await fetch(`https://api.acme-geo-fixture.net/v1/${ip}`);
  return res.json();
}
