'use strict';

import serverConfig from 'eslint-config-nodebb';
import publicConfig from 'eslint-config-nodebb/public';

import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
	{
		ignores: [
			'node_modules/',
			'.project',
			'.vagrant',
			'.DS_Store',
			'.tx',
			'logs/',
			'public/uploads/',
			'public/vendor/',
			'.idea/',
			'.vscode/',
			'*.ipr',
			'*.iws',
			'coverage/',
			'build/',
			'test/files/',
			'*.min.js',
			'install/docker/',
		],
	},
	{
		rules: {
			'no-bitwise': 'warn',
			'no-await-in-loop': 'warn',
		}
	},
	// tests
	{
		files: ['test/**/*.js'],
		languageOptions: {
			ecmaVersion: 2020,
			sourceType: 'commonjs',
			globals: {
				...globals.node,
				...globals.browser,
				it: 'readonly',
				describe: 'readonly',
				before: 'readonly',
				beforeEach: 'readonly',
				after: 'readonly',
				afterEach: 'readonly',
			},
	  	},
		rules: {
	  		'no-unused-vars': 'off',
			'no-prototype-builtins': 'off',
		}
  	},
	...publicConfig,
	...serverConfig
]);

