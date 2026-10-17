/** @type {import('next').NextConfig} */
export default {
  // Proxy to the audit API so the browser stays same-origin (no CORS, one URL to configure).
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${process.env.AUDIT_API_URL ?? 'http://localhost:3100'}/:path*` },
      { source: '/shop-api/:path*', destination: `${process.env.SHOP_API_URL ?? 'http://localhost:3300'}/:path*` },
    ];
  },
};
