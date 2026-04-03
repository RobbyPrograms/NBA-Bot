import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-geist)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      colors: {
        roli: {
          cyan: "#22d3ee",
          violet: "#a78bfa",
          gold: "#fbbf24",
          deep: "#050810",
        },
      },
      boxShadow: {
        "3d": "0 10px 40px -10px rgba(0,0,0,0.45), 0 0 0 1px rgba(34,211,238,0.1), inset 0 1px 0 rgba(255,255,255,0.05)",
      },
    },
  },
  plugins: [],
};

export default config;
