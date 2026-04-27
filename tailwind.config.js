/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/public/**/*.html'],
  theme: {
    extend: {}
  },
  plugins: [require('daisyui')],
  daisyui: {
    // Order matches in-app theme picker (DaisyUI built-ins; newer names like silk/abyss need DaisyUI 5+).
    themes: [
      'autumn',
      'business',
      'acid',
      'lemonade',
      'night',
      'coffee',
      'winter',
      'dim',
      'nord',
      'sunset'
    ],
    darkTheme: 'autumn',
    logs: false
  }
};
