/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export → drops onto S3 + CloudFront (no server needed).
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  devIndicators: false,   // hide the dev-mode "N" badge bottom-left
};
export default nextConfig;
