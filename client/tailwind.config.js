/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Jua', 'Apple SD Gothic Neo', 'Malgun Gothic', 'sans-serif'],
        body: ['"Gowun Dodum"', 'Apple SD Gothic Neo', 'Malgun Gothic', 'sans-serif'],
      },
      colors: {
        ink: '#3b2f63',
        grape: '#7c5cff',
        bubble: '#ff7eb6',
        lemon: '#ffd84d',
        mint: '#5fe0c1',
        sky: '#7cc8ff',
        cream: '#fff8ef',
      },
      boxShadow: {
        pop: '0 6px 0 rgba(59,47,99,0.22)',
        popsm: '0 3px 0 rgba(59,47,99,0.22)',
      },
      keyframes: {
        pop: { '0%': { transform: 'scale(0.3)', opacity: '0' }, '60%': { transform: 'scale(1.15)' }, '100%': { transform: 'scale(1)', opacity: '1' } },
        floaty: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-8px)' } },
        rise: { '0%': { transform: 'translateY(24px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        wiggle: { '0%,100%': { transform: 'rotate(-4deg)' }, '50%': { transform: 'rotate(4deg)' } },
      },
      animation: {
        pop: 'pop 0.45s cubic-bezier(.2,1.4,.4,1) both',
        floaty: 'floaty 3s ease-in-out infinite',
        rise: 'rise 0.4s ease-out both',
        wiggle: 'wiggle 0.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
