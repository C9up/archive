/**
 * `ream configure @c9up/archive` — wire file storage in one command.
 *
 * The provider alone is not enough: it reads `config/archive.ts`, and a package
 * registered without one falls back to a default that is rarely the one an
 * application wants. Writing both together is what makes `ream add` mean
 * installed AND working.
 */

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads these, so they are declared here. Writing the file
	// without them leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({
		DRIVE_DISK: "fs",
	});

	await codemods.addProvider("@c9up/archive/provider");
	await codemods.writeFile(
		"config/archive.ts",
		`import { defineConfig, services } from '@c9up/archive'
import env from '#start/env'

export default defineConfig({
  // The disk used when \`drive.use()\` is called with no argument.
  default: env.get('DRIVE_DISK', 'fs'),

  services: {
    fs: services.fs({
      location: 'storage/uploads',
      // Required before \`getSignedUrl\` will answer on the local disk.
      signingSecret: env.get('APP_KEY'),
    }),
    // s3: services.s3({ bucket: env.get('S3_BUCKET'), region: env.get('S3_REGION') }),
  },
})`,
	);
}
