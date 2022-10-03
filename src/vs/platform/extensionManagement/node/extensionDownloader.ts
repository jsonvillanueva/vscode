/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Promises } from 'vs/base/common/async';
import { getErrorMessage } from 'vs/base/common/errors';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { isWindows } from 'vs/base/common/platform';
import { joinPath } from 'vs/base/common/resources';
import * as semver from 'vs/base/common/semver/semver';
import { URI } from 'vs/base/common/uri';
import { generateUuid } from 'vs/base/common/uuid';
import { Promises as FSPromises } from 'vs/base/node/pfs';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { IExtensionGalleryService, IGalleryExtension, InstallOperation } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionKey, groupByExtension } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IFileService, IFileStatWithMetadata } from 'vs/platform/files/common/files';
import { ILogService } from 'vs/platform/log/common/log';

export interface IExtensionsDownloader extends IDisposable {
	delete(location: URI): Promise<void>;
	downloadExtension(extension: IGalleryExtension, operation: InstallOperation): Promise<{ extensionLocation: URI; signatureArchiveLocation?: URI }>;
}

export class ExtensionsDownloader extends Disposable implements IExtensionsDownloader {

	readonly extensionsDownloadDir: URI;
	private readonly cache: number;
	private readonly cleanUpPromise: Promise<void>;

	private static readonly SignatureArchiveExtension = '.sigzip';

	constructor(
		@INativeEnvironmentService environmentService: INativeEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IExtensionGalleryService private readonly extensionGalleryService: IExtensionGalleryService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.extensionsDownloadDir = URI.file(environmentService.extensionsDownloadPath);
		this.cache = 20; // Cache 20 downloaded VSIX files
		this.cleanUpPromise = this.cleanUp();
	}

	async downloadExtension(extension: IGalleryExtension, operation: InstallOperation): Promise<{ extensionLocation: URI; signatureArchiveLocation?: URI }> {
		await this.cleanUpPromise;
		const vsixName = this.getName(extension);
		const extensionLocation = joinPath(this.extensionsDownloadDir, vsixName);
		let signatureArchiveLocation: URI | undefined;

		await this.downloadFile(extensionLocation, extension, operation, 'vsix', this.extensionGalleryService.download);

		if (extension.assets.signature) {
			signatureArchiveLocation = ExtensionsDownloader.getSignatureArchiveLocation(extensionLocation);

			await this.downloadFile(signatureArchiveLocation, extension, operation, 'signature archive', this.extensionGalleryService.downloadSignatureArchive);
		}

		return { extensionLocation, signatureArchiveLocation };
	}

	private async downloadFile(location: URI, extension: IGalleryExtension, operation: InstallOperation, fileType: string, download: (extension: IGalleryExtension, location: URI, operation: InstallOperation) => Promise<void>) {
		if (!await this.fileService.exists(location)) {
			// Download to temporary location first only if file does not exist
			const tempLocation = joinPath(this.extensionsDownloadDir, `.${generateUuid()}`);
			if (!await this.fileService.exists(tempLocation)) {
				await download(extension, tempLocation, operation);
			}

			try {
				// Rename temp location to original
				await this.rename(tempLocation, location, Date.now() + (2 * 60 * 1000) /* Retry for 2 minutes */);
			} catch (error) {
				try {
					await this.fileService.del(tempLocation);
				} catch (e) { /* ignore */ }
				if (error.code === 'ENOTEMPTY') {
					this.logService.info(`Rename failed because ${fileType} was downloaded by another source. So ignoring renaming.`, extension.identifier.id);
				} else {
					this.logService.info(`Rename failed because of ${getErrorMessage(error)}. Deleted the ${fileType} from downloaded location`, tempLocation.path);
					throw error;
				}
			}
		}
	}

	async delete(location: URI): Promise<void> {
		await this.cleanUpPromise;
		await this.fileService.del(location);
	}

	private async rename(from: URI, to: URI, retryUntil: number): Promise<void> {
		try {
			await FSPromises.rename(from.fsPath, to.fsPath);
		} catch (error) {
			if (isWindows && error && error.code === 'EPERM' && Date.now() < retryUntil) {
				this.logService.info(`Failed renaming ${from} to ${to} with 'EPERM' error. Trying again...`);
				return this.rename(from, to, retryUntil);
			}
			throw error;
		}
	}

	private async cleanUp(): Promise<void> {
		try {
			if (!(await this.fileService.exists(this.extensionsDownloadDir))) {
				this.logService.trace('Extension VSIX downloads cache dir does not exist');
				return;
			}
			const folderStat = await this.fileService.resolve(this.extensionsDownloadDir, { resolveMetadata: true });
			if (folderStat.children) {
				const toDelete: URI[] = [];
				const all: [ExtensionKey, IFileStatWithMetadata][] = [];
				const signatureArchives = new Set<string>();

				for (const stat of folderStat.children) {
					const name = stat.name;

					if (ExtensionsDownloader.isSignatureArchive(name)) {
						const extensionPath = ExtensionsDownloader.getExtensionPath(name);
						signatureArchives.add(extensionPath);
						continue;
					}

					const extension = ExtensionKey.parse(name);
					if (extension) {
						all.push([extension, stat]);
					}
				}
				const byExtension = groupByExtension(all, ([extension]) => extension);
				const distinct: IFileStatWithMetadata[] = [];
				for (const p of byExtension) {
					p.sort((a, b) => semver.rcompare(a[0].version, b[0].version));
					toDelete.push(...p.slice(1).map(e => e[1].resource)); // Delete outdated extensions
					distinct.push(p[0][1]);
				}
				distinct.sort((a, b) => a.mtime - b.mtime); // sort by modified time
				toDelete.push(...distinct.slice(0, Math.max(0, distinct.length - this.cache)).map(s => s.resource)); // Retain minimum cacheSize and delete the rest

				await Promises.settled(toDelete.map(resource => {
					this.logService.trace('Deleting vsix from cache', resource.path);

					let promise = Promise.resolve();

					if (signatureArchives.has(resource.fsPath)) {
						const signatureArchiveLocation = ExtensionsDownloader.getSignatureArchiveLocation(resource);

						promise = promise.then(() => this.fileService.del(signatureArchiveLocation));
					}

					promise = promise.then(() => this.fileService.del(resource));

					return promise;
				}));
			}
		} catch (e) {
			this.logService.error(e);
		}
	}

	private static getExtensionPath(signatureArchivePath: string): string {
		return signatureArchivePath.substring(0, signatureArchivePath.length - ExtensionsDownloader.SignatureArchiveExtension.length);
	}

	private static getSignatureArchiveLocation(extensionLocation: URI): URI {
		return URI.file(extensionLocation.fsPath + ExtensionsDownloader.SignatureArchiveExtension);
	}

	private static isSignatureArchive(name: string): boolean {
		return name.endsWith(ExtensionsDownloader.SignatureArchiveExtension);
	}

	private getName(extension: IGalleryExtension): string {
		return this.cache ? ExtensionKey.create(extension).toString().toLowerCase() : generateUuid();
	}

}
