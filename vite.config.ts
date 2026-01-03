import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      // Don't bundle React - it's provided by the host app
      external: ['react', 'react-dom'],
      output: {
        // Provide global variables for externals
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
      },
    },
    // Output to plugin root
    outDir: '.',
    emptyOutDir: false,
  },
})
