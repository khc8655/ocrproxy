import animate from "tailwindcss-animate"

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
  	extend: {
      /* __DS_BURN_START__ */
      fontFamily: { sans: ["var(--font-body)"], display: ["var(--font-display)"], mono: ["var(--font-mono)"] },
      spacing: { "1": "var(--space-1)", "12": "var(--space-12)", "2": "var(--space-2)", "3": "var(--space-3)", "4": "var(--space-4)", "5": "var(--space-5)", "6": "var(--space-6)", "8": "var(--space-8)" },
      boxShadow: { "none": "var(--elev-flat)", "sm": "var(--elev-ring)", "DEFAULT": "var(--elev-raised)", "md": "var(--elev-raised)", "lg": "var(--elev-raised)", "xl": "var(--elev-raised)", "focus": "var(--focus-ring)" },
      fontSize: { "2xl": ["var(--text-2xl)", "var(--leading-tight)"], "3xl": ["var(--text-3xl)", "var(--leading-tight)"], "4xl": ["var(--text-4xl)", "var(--leading-tight)"], "base": ["var(--text-base)", "var(--leading-body)"], "lg": ["var(--text-lg)", "var(--leading-body)"], "sm": ["var(--text-sm)", "var(--leading-body)"], "xl": ["var(--text-xl)", "var(--leading-tight)"], "xs": ["var(--text-xs)", "var(--leading-body)"] }, /* __DS_BURN_END__ */
  		colors: {
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			success: {
  				DEFAULT: 'hsl(var(--success))',
  				foreground: 'hsl(var(--success-foreground))'
  			},
  			warning: {
  				DEFAULT: 'hsl(var(--warning))',
  				foreground: 'hsl(var(--warning-foreground))'
  			},
  			info: {
  				DEFAULT: 'hsl(var(--info))',
  				foreground: 'hsl(var(--info-foreground))'
  			},
  			violet: {
  				DEFAULT: 'hsl(var(--violet))'
  			},
  			teal: {
  				DEFAULT: 'hsl(var(--teal))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			}
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [animate],
}
