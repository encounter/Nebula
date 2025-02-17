/* tslint:disable:no-shadowed-variable */
import dotenv from 'dotenv'
import { writeFile } from 'fs-extra'
import { resolve as resolvePath } from 'path'
import { URL } from 'url'
import { inspect } from 'util'
import yargs from 'yargs'
import { DistributionStructure } from './model/struct/model/distribution.struct'
import { ServerStructure } from './model/struct/model/server.struct'
import { VersionSegmentedRegistry } from './util/VersionSegmentedRegistry'
import { VersionUtil } from './util/versionutil'
import { MinecraftVersion } from './util/MinecraftVersion'
import { LoggerUtil } from './util/LoggerUtil'

dotenv.config()

const logger = LoggerUtil.getLogger('Index')

function getRoot(): string {
    return resolvePath(process.env.ROOT as string)
}

function getBaseURL(): string {
    let baseUrl = process.env.BASE_URL as string
    // Users must provide protocol in all other instances.
    if (baseUrl.indexOf('//') === -1) {
        if (baseUrl.toLowerCase().startsWith('localhost')) {
            baseUrl = 'http://' + baseUrl
        } else {
            throw new TypeError('Please provide a URL protocol (ex. http:// or https://)')
        }
    }
    return (new URL(baseUrl)).toString()
}

// function rootOption(yargs: yargs.Argv) {
//     return yargs.option('root', {
//         describe: 'File structure root.',
//         type: 'string',
//         demandOption: true,
//         global: true
//     })
//     .coerce({
//         root: resolvePath
//     })
// }

// function baseUrlOption(yargs: yargs.Argv) {
//     return yargs.option('baseUrl', {
//         describe: 'Base url of your file host.',
//         type: 'string',
//         demandOption: true,
//         global: true
//     })
//     .coerce({
//         baseUrl: (arg: string) => {
//             // Users must provide protocol in all other instances.
//             if (arg.indexOf('//') === -1) {
//                 if (arg.toLowerCase().startsWith('localhost')) {
//                     arg = 'http://' + arg
//                 } else {
//                     throw new TypeError('Please provide a URL protocol (ex. http:// or https://)')
//                 }
//             }
//             return (new URL(arg)).toString()
//         }
//     })
// }

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function namePositional(yargs: yargs.Argv) {
    return yargs.option('name', {
        describe: 'Distribution index file name.',
        type: 'string',
        default: 'distribution'
    })
}

// -------------
// Init Commands

const initRootCommand: yargs.CommandModule = {
    command: 'root',
    describe: 'Generate an empty standard file structure.',
    builder: (yargs) => {
        // yargs = rootOption(yargs)
        return yargs
    },
    handler: async (argv) => {
        argv.root = getRoot()

        logger.debug(`Root set to ${argv.root}`)
        logger.debug('Invoked init root.')
        try {
            await new DistributionStructure(argv.root as string, '').init()
            logger.info(`Successfully created new root at ${argv.root}`)
        } catch (error) {
            logger.error(`Failed to init new root at ${argv.root}`, error)
        }
    }
}

const initCommand: yargs.CommandModule = {
    command: 'init',
    aliases: ['i'],
    describe: 'Base init command.',
    builder: (yargs) => {
        return yargs
            .command(initRootCommand)
    },
    handler: (argv) => {
        argv._handled = true
    }
}

// -----------------
// Generate Commands

const generateServerCommand: yargs.CommandModule = {
    command: 'server <id> <version>',
    describe: 'Generate a new server configuration.',
    builder: (yargs) => {
        // yargs = rootOption(yargs)
        return yargs
            .positional('id', {
                describe: 'Server id.',
                type: 'string'
            })
            .positional('version', {
                describe: 'Minecraft version.',
                type: 'string'
            })
            .option('forge', {
                describe: 'Forge version.',
                type: 'string',
                default: null
            })
            .option('liteloader', {
                describe: 'LiteLoader version.',
                type: 'string',
                default: null
            })
    },
    handler: async (argv) => {
        argv.root = getRoot()

        logger.debug(`Root set to ${argv.root}`)
        logger.debug(`Generating server ${argv.id} for Minecraft ${argv.version}.`,
            `\n\t├ Forge version: ${argv.forge}`,
            `\n\t└ LiteLoader version: ${argv.liteloader}`)

        const minecraftVersion = new MinecraftVersion(argv.version as string)

        if(argv.forge != null) {
            if (VersionUtil.isPromotionVersion(argv.forge as string)) {
                logger.debug(`Resolving ${argv.forge} Forge Version..`)
                const version = await VersionUtil.getPromotedForgeVersion(minecraftVersion, argv.forge as string)
                logger.debug(`Forge version set to ${version}`)
                argv.forge = version
            }
        }

        const serverStruct = new ServerStructure(argv.root as string, getBaseURL())
        serverStruct.createServer(
            argv.id as string,
            minecraftVersion,
            {
                forgeVersion: argv.forge as string,
                liteloaderVersion: argv.liteloader as string
            }
        )

    }
}

const generateDistroCommand: yargs.CommandModule = {
    command: 'distro [name]',
    describe: 'Generate a distribution index from the root file structure.',
    builder: (yargs) => {
        // yargs = rootOption(yargs)
        // yargs = baseUrlOption(yargs)
        yargs = namePositional(yargs)
        return yargs
    },
    handler: async (argv) => {
        argv.root = getRoot()
        argv.baseUrl = getBaseURL()

        logger.debug(`Root set to ${argv.root}`)
        logger.debug(`Base Url set to ${argv.baseUrl}`)
        logger.debug(`Invoked generate distro name ${argv.name}.json.`)
        try {
            const distributionStruct = new DistributionStructure(argv.root as string, argv.baseUrl as string)
            const distro = await distributionStruct.getSpecModel()
            const distroPath = resolvePath(argv.root as string, `${argv.name}.json`)
            writeFile(distroPath, JSON.stringify(distro, null, 2))
            logger.info(`Successfully generated ${argv.name}.json`)
            logger.info(`Saved to ${distroPath}`)
            logger.debug('Preview:\n', distro)
        } catch (error) {
            logger.error(`Failed to generate distribution with root ${argv.root}.`, error)
        }
    }
}

const generateCommand: yargs.CommandModule = {
    command: 'generate',
    aliases: ['g'],
    describe: 'Base generate command.',
    builder: (yargs) => {
        return yargs
            .command(generateServerCommand)
            .command(generateDistroCommand)
    },
    handler: (argv) => {
        argv._handled = true
    }
}

const validateCommand: yargs.CommandModule = {
    command: 'validate [name]',
    describe: 'Validate a distribution.json against the spec.',
    builder: (yargs) => {
        return namePositional(yargs)
    },
    handler: (argv) => {
        logger.debug(`Invoked validate with name ${argv.name}.json`)
    }
}

const latestForgeCommand: yargs.CommandModule = {
    command: 'latest-forge <version>',
    describe: 'Get the latest version of forge.',
    handler: async (argv) => {
        logger.debug(`Invoked latest-forge with version ${argv.version}.`)

        const minecraftVersion = new MinecraftVersion(argv.version as string)
        const forgeVer = await VersionUtil.getPromotedForgeVersion(minecraftVersion, 'latest')
        logger.info(`Latest version: Forge ${forgeVer} (${argv.version})`)
    }
}

const recommendedForgeCommand: yargs.CommandModule = {
    command: 'recommended-forge <version>',
    describe: 'Get the recommended version of forge. Returns latest if there is no recommended build.',
    handler: async (argv) => {
        logger.debug(`Invoked recommended-forge with version ${argv.version}.`)

        const index = await VersionUtil.getPromotionIndex()
        const minecraftVersion = new MinecraftVersion(argv.version as string)

        let forgeVer = VersionUtil.getPromotedVersionStrict(index, minecraftVersion, 'recommended')
        if (forgeVer != null) {
            logger.info(`Recommended version: Forge ${forgeVer} (${minecraftVersion})`)
        } else {
            logger.info(`No recommended build for ${minecraftVersion}. Checking for latest version..`)
            forgeVer = VersionUtil.getPromotedVersionStrict(index, minecraftVersion, 'latest')
            if (forgeVer != null) {
                logger.info(`Latest version: Forge ${forgeVer} (${minecraftVersion})`)
            } else {
                logger.info(`No build available for ${minecraftVersion}.`)
            }
        }

    }
}

const testCommand: yargs.CommandModule = {
    command: 'test <mcVer> <forgeVer>',
    describe: 'Validate a distribution.json against the spec.',
    builder: (yargs) => {
        return namePositional(yargs)
    },
    handler: async (argv) => {
        logger.debug(`Invoked test with mcVer ${argv.mcVer} forgeVer ${argv.forgeVer}`)
        logger.info(process.cwd())
        const mcVer = new MinecraftVersion(argv.mcVer as string)
        const resolver = VersionSegmentedRegistry.getForgeResolver(mcVer,
            argv.forgeVer as string, getRoot(), '', getBaseURL())
        if (resolver != null) {
            const mdl = await resolver.getModule()
            logger.info(inspect(mdl, false, null, true))
        }
    }
}

// Registering yargs configuration.
// tslint:disable-next-line:no-unused-expression
yargs
    .version(false)
    .scriptName('')
    .command(initCommand)
    .command(generateCommand)
    .command(validateCommand)
    .command(latestForgeCommand)
    .command(recommendedForgeCommand)
    .command(testCommand)
    .demandCommand()
    .help()
    .argv
