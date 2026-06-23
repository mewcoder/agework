// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // 层次边界（§6）：agent 层只能经 runs/run.service 门面与 run-service.types 触达下层，
  // 不得 deep import runtime 内部实现或 runs 的入站/事件管线。
  {
    files: ['src/agent/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/runtime/core/**',
                '**/runtime/providers/**',
                '**/runtime/internal/**',
                '**/runtime/runtime.service',
              ],
              message:
                'agent 层不得 import runtime 内部实现；执行环境只能经 runs/run.service(RunService) 门面间接使用。',
            },
            {
              group: ['**/runs/execution/**', '**/runs/events/**'],
              message:
                'agent 层不得 import runs 的入站/事件内部；只能用 runs/run.service 门面与 run-service.types。',
            },
          ],
        },
      ],
    },
  },
);
