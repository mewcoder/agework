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
      // 下划线前缀表示「有意未使用」(占位参数 / 解构丢弃)。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // 层次边界（§6）：agent 层只能经 run/run.service 门面与 run.types 触达下层，
  // 不得 deep import runtime 内部实现或 run 的入站/事件管线。
  {
    files: ['src/conversation/agent/**/*.ts'],
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
                'agent 层不得 import runtime 内部实现；执行环境只能经 run/run.service(RunService) 门面间接使用。',
            },
            {
              group: ['**/run/execution/**'],
              message:
                'agent 层不得 import run 的入站/事件内部；只能用 run/run.service 门面与 run.types。',
            },
          ],
        },
      ],
    },
  },
  // 测试文件用手搓 mock,会大量产生 `any`;type-aware 的 unsafe-* 与 unbound-method
  // 在 mock 上几乎全是噪音,对 *.spec.ts 关闭(其余规则仍生效)。
  {
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // mock 常以 async 签名对齐被测接口,体内无 await 属正常。
      '@typescript-eslint/require-await': 'off',
    },
  },
);
