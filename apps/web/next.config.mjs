/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared package ships TypeScript sources compiled to CommonJS; Next has
  // to transpile it rather than treat it as a prebuilt ESM dependency.
  transpilePackages: ['@aiedit/shared'],
  images: {
    // Generated media is served from the API (local driver) or object storage.
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost' },
      { protocol: 'https', hostname: '**' },
    ],
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
