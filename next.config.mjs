/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `ws` is a native-ish Node dependency used only by the Rime WebSocket
  // adapter. Keeping it external stops Next from trying to bundle it into the
  // server build.
  serverExternalPackages: ['ws'],
};

export default nextConfig;
