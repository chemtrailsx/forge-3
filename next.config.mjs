/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `ws` is a native-ish Node dependency used only by the Rime WebSocket
  // adapter. Keeping it external stops Next from trying to bundle it into the
  // server build.
  serverExternalPackages: ['ws'],

  /**
   * Where compiled output goes — and deliberately not the same place in dev
   * and in a build.
   *
   * `next build` otherwise writes over the directory a running `next dev` is
   * serving from, removing its `routes-manifest.json` on the way past. The dev
   * server then returns 500 on every route until it is restarted, with an
   * ENOENT that says nothing about the build that caused it. Verifying a
   * production build should never take someone's running app down.
   *
   * `next dev` sets NODE_ENV=development and `next build`/`next start` set
   * production, so the split needs no extra tooling. A deployment target that
   * insists on `.next` can set NEXT_DIST_DIR.
   */
  distDir:
    process.env.NEXT_DIST_DIR || (process.env.NODE_ENV === 'production' ? '.next-build' : '.next'),
};

export default nextConfig;
