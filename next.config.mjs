/**
 * True for `next build` run on a developer's machine, where a dev server may
 * be serving out of `.next` at the same time. False on Vercel, in CI, and in
 * any container build, all of which expect the output where Next puts it by
 * default.
 */
function isLocalProductionBuild() {
  if (process.env.NODE_ENV !== 'production') return false;
  return !process.env.CI && !process.env.VERCEL && !process.env.NETLIFY;
}

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
   * production, so the split needs no extra tooling.
   *
   * Only local builds are redirected. A build on Vercel or in CI has no dev
   * server to protect and its tooling looks for `.next`, so moving the output
   * there would trade a local annoyance for a deployment that silently
   * produces nothing.
   */
  distDir: process.env.NEXT_DIST_DIR || (isLocalProductionBuild() ? '.next-build' : '.next'),
};

export default nextConfig;
