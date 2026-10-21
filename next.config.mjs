/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // ESLint is optional for this tool; skip it during production builds so the
  // build does not require the eslint-config-next toolchain to be installed.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
