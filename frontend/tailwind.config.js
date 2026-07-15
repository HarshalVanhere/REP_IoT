/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        industrial: {
          bg: '#F8FAFC',         // Slate 50 (Light grayish blue)
          card: '#FFFFFF',       // Pure white card
          border: '#E2E8F0',     // Slate 200 border
          textMuted: '#64748B',  // Slate 500 text
          accent: '#0284C7',     // Sky 600 corporate blue
          running: '#059669',    // Emerald 600 green
          stopped: '#DC2626',    // Red 600 red
          nosignal: '#7C3AED'    // Purple 600 purple
        }
      },
      fontFamily: {
        sans: ['Outfit', 'Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-status': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'pulse-glow': 'pulseGlow 2s infinite alternate'
      },
      keyframes: {
        pulseGlow: {
          '0%': { boxShadow: '0 0 5px rgba(5, 150, 105, 0.1)' },
          '100%': { boxShadow: '0 0 12px rgba(5, 150, 105, 0.3)' }
        }
      }
    },
  },
  plugins: [],
}
