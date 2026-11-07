import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(js.configs.recommended, tseslint.configs.recommended, {
  rules: {
    'func-style': ['error', 'expression'],
    'prefer-arrow-callback': 'error',
    'no-console': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
  },
});
