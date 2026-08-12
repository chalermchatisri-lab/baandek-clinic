/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        clinic: {
          bg: "#FBFAF7", surface: "#FFFFFF", border: "#E8E4DB",
          ink: "#2C2C2A", muted: "#6B6A64",
          primary: "#0F6E56", primary600: "#1D9E75", primary050: "#E1F5EE",
          accent: "#D85A30", danger: "#A32D2D",
        },
      },
      fontFamily: { sans: ['"IBM Plex Sans Thai"', "system-ui", "sans-serif"] },
    },
  },
  plugins: [],
};
