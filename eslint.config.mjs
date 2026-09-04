import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json"
      }
    },
    rules: {
      // TypeScript specific rules
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",

      // General rules
      "no-console": "off", // Allow console for logging
      "no-debugger": "warn",
      "no-alert": "warn",
      "prefer-const": "warn",
      "no-var": "error",
      "object-shorthand": "warn",
      "quote-props": ["warn", "as-needed"],

      // Code quality
      "eqeqeq": ["error", "always"],
      "curly": ["warn", "all"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-with": "error",
      "no-new-func": "error",

      // Best practices
      "no-unused-expressions": "warn",
      "no-useless-return": "warn",
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",

      // Style
      "semi": ["warn", "never"],
      "quotes": ["warn", "double", { avoidEscape: true }],
      "comma-dangle": ["warn", "only-multiline"],
      "arrow-body-style": ["warn", "as-needed"],
    }
  },
  {
    ignores: [
      "node_modules/",
      "build/",
      "dist/",
      "coverage/",
      "*.js",
      "*.d.ts",
      "eslint.config.mjs"
    ]
  }
)
