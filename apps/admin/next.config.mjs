/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared package ships TypeScript source-built ESM; Next needs to
  // compile it rather than treat it as a prebuilt CJS dependency.
  transpilePackages: ['@outcome/shared'],
};

export default nextConfig;
