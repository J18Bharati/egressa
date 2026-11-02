export async function locate(ip) {
  const res = await fetch(`https://api.acme-geo.example.net/v1/${ip}`);
  return res.json();
}
