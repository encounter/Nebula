import AdmZip from 'adm-zip'
import { createHash } from 'crypto'
import { copy, lstat, mkdirs, pathExists, readFile, remove, Stats } from 'fs-extra'
import { basename, join } from 'path'
import { VersionManifest } from '../../../model/forge/versionmanifest'
import { Artifact } from '../../../model/spec/artifact'
import { Module } from '../../../model/spec/module'
import { Type } from '../../../model/spec/type'
import { ForgeRepoStructure } from '../../../model/struct/repo/forgerepo.struct'
import { MavenUtil } from '../../../util/maven'
import { PackXZExtractWrapper } from '../../../util/PackXZExtractWrapper'
import { ForgeResolver } from '../forge.resolver'

export class Forge18Adapter extends ForgeResolver {

    public static isForVersion(version: string) {
        return Forge18Adapter.isVersionAcceptable(version, [8, 9, 10, 11, 12])
    }

    constructor(
        absoluteRoot: string,
        relativeRoot: string,
        minecraftVersion: string,
        forgeVersion: string
    ) {
        super(absoluteRoot, relativeRoot, minecraftVersion, forgeVersion)
    }

    public async getModule(): Promise<Module> {
        return this.getForgeByVersion()
    }

    public isForVersion(version: string) {
        return Forge18Adapter.isForVersion(version)
    }

    public async getForgeByVersion() {
        const forgeRepo = this.repoStructure.getForgeRepoStruct()
        const artifactVersion = `${this.minecraftVersion}-${this.forgeVersion}`
        const targetLocalPath = forgeRepo.getLocalForge(artifactVersion, 'universal')
        console.debug(`Checking for forge version at ${targetLocalPath}..`)
        if (!await forgeRepo.artifactExists(targetLocalPath)) {
            console.debug(`Forge not found locally, initializing download..`)
            await forgeRepo.downloadArtifactByComponents(
                this.REMOTE_REPOSITORY,
                ForgeRepoStructure.FORGE_GROUP,
                ForgeRepoStructure.FORGE_ARTIFACT,
                artifactVersion, 'universal', 'jar')
        } else {
            console.debug('Using locally discovered forge.')
        }
        console.debug(`Beginning processing of Forge v${this.forgeVersion} (Minecraft ${this.minecraftVersion})`)

        const forgeUniversalBuffer = await readFile(targetLocalPath)
        const zip = new AdmZip(forgeUniversalBuffer)
        const zipEntries = zip.getEntries()

        let versionManifest

        for (const entry of zipEntries) {
            if (entry.entryName === 'version.json') {
                versionManifest = zip.readAsText(entry)
                break
            }
        }

        if (!versionManifest) {
            throw new Error('Failed to find version.json in forge universal jar.')
        }

        versionManifest = JSON.parse(versionManifest) as VersionManifest

        const forgeModule: Module = {
            id: MavenUtil.mavenComponentsToIdentifier(
                ForgeRepoStructure.FORGE_GROUP,
                ForgeRepoStructure.FORGE_ARTIFACT,
                artifactVersion, 'universal'
            ),
            name: 'Minecraft Forge',
            type: Type.ForgeHosted,
            artifact: this.generateArtifact(forgeUniversalBuffer, await lstat(targetLocalPath)),
            subModules: []
        }

        const postProcessQueue = []

        for (const lib of versionManifest.libraries) {
            if (lib.name.startsWith('net.minecraftforge:forge:')) {
                // We've already processed forge.
                continue
            }
            console.debug(`Processing ${lib.name}..`)

            const libRepo = this.repoStructure.getLibRepoStruct()
            const extension = this.determineExtension(lib.checksums)
            const localPath = libRepo.getArtifactById(lib.name, extension) as string

            const postProcess = extension === 'jar.pack.xz'

            let queueDownload = !await libRepo.artifactExists(localPath)
            let libBuf

            if (!queueDownload) {
                libBuf = await readFile(localPath)
                // VERIFY HASH
                if (!postProcess) { // Checksums for .pack.xz in the version.json are completely useless.
                    if (lib.checksums != null) {
                        const sha1 = createHash('sha1').update(libBuf).digest('hex')
                        if (sha1 !== lib.checksums[0]) {
                            console.debug('Hashes do not match, redownloading..')
                            queueDownload = true
                        }
                    }
                }
            } else {
                console.debug(`Not found locally, downloading..`)
                queueDownload = true
            }

            if (queueDownload) {
                await libRepo.downloadArtifactById(lib.url || 'https://libraries.minecraft.net/', lib.name, extension)
                libBuf = await readFile(localPath)
            } else {
                console.debug('Using local copy.')
            }

            const stats = await lstat(localPath)

            const mavenComponents = MavenUtil.getMavenComponents(lib.name)
            const properId = MavenUtil.mavenComponentsToIdentifier(
                mavenComponents.group, mavenComponents.artifact, mavenComponents.version,
                mavenComponents.classifier, extension
            )

            forgeModule.subModules?.push({
                id: properId,
                name: `Minecraft Forge (${mavenComponents?.artifact})`,
                type: Type.Library,
                artifact: this.generateArtifact(libBuf as Buffer, stats)
            })

            if (postProcess) {
                postProcessQueue.push({
                    id: properId,
                    localPath
                })
            }

        }

        for (const entry of await this.processPackXZFiles(postProcessQueue)) {
            const el = forgeModule.subModules?.find((element) => element.id === entry.id)
            if (el != null) {
                el.artifact.MD5 = entry.MD5
            } else {
                console.error(`Error during post processing, could not update ${entry.id}`)
            }
        }

        return forgeModule
    }

    private generateArtifact(buf: Buffer, stats: Stats): Artifact {
        return {
            size: stats.size,
            MD5: createHash('md5').update(buf).digest('hex'),
            url: 'TODO'
        }
    }

    private determineExtension(checksums: string[] | undefined) {
        return checksums != null && checksums.length > 1 ? 'jar.pack.xz' : 'jar'
    }

    private async processPackXZFiles(
        processingQueue: Array<{id: string, localPath: string}>): Promise<Array<{id: string, MD5: string}>> {

        const accumulator = []

        const tempDir = this.repoStructure.getTempDirectory()

        if (await pathExists(tempDir)) {
            await remove(tempDir)
        }

        await mkdirs(tempDir)

        const files = []
        for (const entry of processingQueue) {
            const tmpFile = join(tempDir, basename(entry.localPath))
            await copy(entry.localPath, tmpFile)
            files.push(tmpFile)
        }

        console.debug('Spawning PackXZExtract.')
        await PackXZExtractWrapper.extractUnpack(files)
        console.debug('All filex extracted, calculating hashes..')

        for (const entry of processingQueue) {
            const tmpFileName = basename(entry.localPath)
            const tmpFile = join(tempDir, tmpFileName.substring(0, tmpFileName.indexOf('.pack.xz')))
            const buf = await readFile(tmpFile)
            accumulator.push({
                id: entry.id,
                MD5: createHash('md5').update(buf).digest('hex')
            })
        }

        console.debug('Complete, removing temp directory..')

        await remove(tempDir)

        return accumulator
    }

}