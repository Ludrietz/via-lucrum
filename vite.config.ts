import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works at any URL depth: the domain
  // root, a GitHub Pages project subpath, or straight off the file system.
  base: './',
  server: {
    // Bind to every interface so other machines on the LAN can reach it.
    // Vite prints the Network URL to hand to the other PC.
    host: true,
    port: 5173,
    open: true,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: { target: 'es2020' },
});
