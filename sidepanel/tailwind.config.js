/* Tailwind (Play CDN) configuration for the side panel. */
(() => {
  // Surfaces and text are CSS variables (see styles.css) so light and dark share one set of classes.
  const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

  const system = [
    '-apple-system',
    'BlinkMacSystemFont',
    '"SF Pro Text"',
    '"Segoe UI Variable Text"',
    '"Segoe UI"',
    'system-ui',
    'Roboto',
    '"Helvetica Neue"',
    'sans-serif',
  ];

  tailwind.config = {
    darkMode: 'media',
    theme: {
      extend: {
        fontFamily: {
          sans: system,
          display: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"Segoe UI Variable Display"', ...system.slice(4)],
        },
        colors: {
          // Primary: #5840ba
          brand: {
            50: '#f4f2fc',
            100: '#ebe7f9',
            200: '#d9d2f3',
            300: '#bdb0ea',
            400: '#9d8add',
            500: '#7b64cf',
            600: '#5840ba',
            700: '#4a35a0',
            800: '#3d2d82',
            900: '#33276a',
            950: '#1f1745',
          },
          canvas: token('canvas'),
          raised: token('raised'),
          hover: token('hover'),
          ink: {
            DEFAULT: token('ink'),
            2: token('ink-2'),
            3: token('ink-3'),
          },
          accent: token('accent'),
          fill: 'var(--fill)',
          'fill-strong': 'var(--fill-strong)',
          hairline: 'var(--hairline)',
        },
        boxShadow: {
          pop: '0 0 0 1px var(--hairline), 0 18px 48px -8px rgb(20 12 60 / 0.28), 0 4px 14px -4px rgb(20 12 60 / 0.16)',
          tile: '0 6px 16px -4px rgb(88 64 186 / 0.5), inset 0 1px 0 rgb(255 255 255 / 0.25)',
          key: '0 1px 0 var(--hairline)',
        },
        transitionTimingFunction: {
          // A critically damped spring sampled into linear(): settles with no overshoot.
          spring:
            'linear(0, .0576, .1806, .3213, .4558, .5736, .6717, .7507, .8127, .8606, .897, .9243, .9447, .9598, .9709, .979, .9849, .9892, .9923, .9945, .9961, .9972, .998, .9986, 1)',
        },
      },
    },
  };
})();
