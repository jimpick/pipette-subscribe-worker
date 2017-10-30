const path = require('path')
const { spawn } = require('child_process')
const {
  unlinkSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
  existsSync
} = require('fs')
const Dat = require('dat-node')
const datDns = require('dat-dns')()
const minimist = require('minimist')
const mkdirp = require('mkdirp')
const { throttle, debounce } = require('lodash')
const PQueue = require('p-queue')
const ram = require('random-access-memory')
const mirror = require('mirror-folder')
const del = require('del')

const dataDir = '/mnt/data'

const argv = minimist(process.argv.slice(2), {
  alias: {
    'subscribe': 's',
    'dat-share': 'd'
  },
  boolean: [
    'subscribe',
    'dat-share'
  ],
  default: {
    'subscribe': true,
    'dat-share': true
  }
})

if (argv._.length === 0) {
  console.error('Need a dat archive key')
  process.exit(1)
}

if (argv._.length > 1) {
  console.error('Too many arguments')
  process.exit(1)
}

const sourceDatUrl = argv._[0]

console.log(sourceDatUrl, argv.subscribe, argv['dat-share'])

function subscribeToDat (key) {
  const promise = new Promise((resolve, reject) => {
    Dat(ram, { key, sparse: true }, (error, dat) => {
      if (error) {
        return reject(error)
      }
      dat.joinNetwork(error => {
        if (error) {
          console.error('joinNetwork error', error)
          throw err
        }
        console.log('Network joined')
        const { network } = dat
        const { connected, connecting, queued } = network
        console.log('Network:', connected, connecting, queued)

        // After the first round of network checks, the callback is called
        // If no one is online, you can exit and let the user know.
        /*
        setTimeout(() => {
          const { connected, connecting, queued } = network
          console.log('Network:', connected, connecting, queued)
          if (!connected && !connecting && !queued) {
            console.error('No users currently online for that key.')
            process.exit(1)
          }
        }, 10000)
        */
      })
      resolve(dat)
    })
  })
  return promise
}

function networkTools (dat) {
  const { network } = dat
  network.on('connection', (connection, info) => {
    console.log('network onConnection', info.host)
  })
  network.on('peer', peer => {
    console.log('network peer', peer)
  })
  network.on('drop', peer => {
    console.log('network drop', peer)
  })
  network.on('error', error => {
    console.log('network error', error)
  })
  setInterval(() => {
    const { connected, connecting, queued } = network
    console.log('Network:', connected, connecting, queued)
  }, 5000)
}

function datStatus (dat) {
  const stats = dat.trackStats()
  stats.on('update', throttle(() => {
    const st = stats.get()
    console.log('Stats update:', st)
  }, 1000))
  setInterval(() => {
    console.log('Stats network:', stats.network.downloadSpeed,
      stats.network.uploadSpeed)
    console.log('Stats peers:', stats.peers.total, stats.peers.complete)
  }, 5000)
}

function archiveTools (archive) {
  archive.on('ready', () => {
    console.log('Archive ready', archive.version)
  })
  archive.on('update', () => {
    console.log('Archive update', archive.version)
  })
  archive.on('content', () => {
    console.log('Archive content')
  })
  archive.on('syncing', () => {
    console.log('Archive syncing')
  })
  archive.on('sync', () => {
    console.log('Archive sync')
  })
  archive.on('appending', () => {
    console.log('Archive appending')
  })
  archive.on('append', () => {
    console.log('Archive append')
  })
  archive.on('error', error => {
    console.log('Archive error', error)
  })
}

let lastSyncedVersion = 0

function watchForNewSyncedVersions (archive) {
  archive.on('sync', () => {
    if (archive.version > lastSyncedVersion) {
      console.log('New version synced', archive.version)
      lastSyncedVersion = archive.version
    }
  })
}

function watchHistoryStream (archive) {
  const stream = archive.history()
  stream.on('data', data => {
    console.log('History:', data)
  })
}

function watchForUpdates (archive) {
  let lastUpdateVersion = 0
  const key = archive.key.toString('hex')
  const lastBuilt = `${dataDir}/${key}/last-built`
  if (existsSync(lastBuilt)) {
    lastUpdateVersion = parseInt(readFileSync(lastBuilt, 'utf8'), 10)
    console.log('Last built version:', lastUpdateVersion)
    const dataKeyDir = `${dataDir}/${key}`
    const staticSiteDir = `${dataKeyDir}/static-site`
    if (existsSync(staticSiteDir)) {
      share(staticSiteDir)
    }
  }

  const jobQueue = new PQueue({concurrency: 1})
  const debounceDelay = 5
  let timeoutId

  const queueJob = debounce(() => {
    if (archive.version > lastUpdateVersion) {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      console.log('Update notice received, queuing job', archive.version)

      // const genBuildJob = version => () => doFakeBuild(version)
      const genBuildJob = version => () => doBuild(archive, version)
      jobQueue.add(genBuildJob(archive.version))
      lastUpdateVersion = archive.version
    }
  }, debounceDelay * 1000)
  archive.on('update', () => {
    console.log(
      'Update notice recieved ... ' +
      `debouncing (${debounceDelay} seconds)`
    )
    queueJob()
  })
  // On first run, if there is no immediate update, and there is
  // a version in the already synced dat archive, use that after
  // a timeout (to allow a chance for a new version to sync)
  setTimeout(() => {
    if (!lastUpdateVersion) {
      console.log(
        'No updated version discovered via network yet, ' +
        'delaying 10 seconds to wait for possible updates'
      )
    }
  }, 2000)
  timeoutId = setTimeout(() => {
    if (!argv.subscribe && archive.version <= lastUpdateVersion) {
      console.log('No update found, exiting.')
      process.exit(0)
    }
    queueJob()
  }, 12000)
}

function countdown (version, seconds) {
  const promise = new Promise((resolve, reject) => {
    let counter = 0
    const intervalId = setInterval(() => {
      console.log('  Counter', version, ++counter)
      if (counter >= seconds) {
        clearInterval(intervalId)
        resolve()
      }
    }, 1000)

  })
  return promise
}

async function doFakeBuild (version) {
  console.log('Building version', version)
  await countdown(version, 30)
  console.log('Built version', version)
}

function downloadVersion(archive, version) {
  const promise = new Promise((resolve, reject) => {
    const key = archive.key.toString('hex')
    const sourceDir = `${dataDir}/${key}/source`
    const opts = {
      fs: archive.checkout(version),
      name: '/'
    }
    console.log('  Downloading')
    const progress = mirror(opts, sourceDir, function (error) {
      if (error) {
        console.error('Download error', error)
        return reject(error)
      }
      console.log('  Downloaded')
      resolve()
    })
    progress.on('put', function (src) {
      console.log('    Add', src.name.slice(1))
    })
    progress.on('del', function (src) {
      const name = path.relative(sourceDir, src.name)
      console.log('    Delete', name)
    })
  })
  return promise
}

function runHugo () {
  const promise = new Promise((resolve, reject) => {
    const command = 'npm'
    const args = [
      'run',
      'build'
    ]
    const options = {
      cwd: '/home/worker/hyde-cms-theme'
    }
    console.log('  Running command:', command, args.join(' '))
    const hugo = spawn(
      command,
      args,
      options
    )
    hugo.stdout.on('data', data => {
      process.stdout.write('  ')
      process.stdout.write(data)
    })
    hugo.stderr.on('data', data => {
      process.stdout.write('  ')
      process.stdout.write(data)
    })
    hugo.on('close', code => {
      console.log(`  Build subprocess exited with code ${code}`)
      resolve()
    })
  })
  return promise
}

async function doBuild (archive, version) {
  console.log('Building version', version)

  await downloadVersion(archive, version)

  const key = archive.key.toString('hex')
  const lastBuilt = `${dataDir}/${key}/last-built`
  const sourceDir = `${dataDir}/${key}/source`
  const siteDatSymlink = '/home/worker/hyde-cms-theme/site/dat'
  await del(siteDatSymlink, { force: true })
  symlinkSync(sourceDir, siteDatSymlink)

  const distSymlink = '/home/worker/hyde-cms-theme/dist'
  const dataKeyDir = `${dataDir}/${key}`
  const staticSiteDir = `${dataKeyDir}/static-site`
  await del(distSymlink, { force: true })
  mkdirp.sync(staticSiteDir)
  await del(lastBuilt, { force: true })
  await del(
    [
      `${staticSiteDir}/*`,
      `${staticSiteDir}/.*`,
      `!${staticSiteDir}/.dat`
    ],
    { force: true }
  )
  mkdirp.sync(staticSiteDir)
  symlinkSync(staticSiteDir, distSymlink)

  await runHugo()

  writeFileSync(lastBuilt, `${version}\n`)

  console.log('Built version', version)
  if (!argv.subscribe) {
    console.log('Exiting')
    process.exit(0)
  }
  publish(staticSiteDir)
}

function setupDatSecretKeysSymlink () {
  const dotDatDir = `${process.env.HOME}/.dat`
  mkdirp.sync(dotDatDir)
  const secretKeysDir = `${dataDir}/secret_keys`
  mkdirp.sync(secretKeysDir)
  const secretKeysSymlink = `${dotDatDir}/secret_keys`
  if (!existsSync(secretKeysSymlink)) {
    del.sync(secretKeysSymlink)
    symlinkSync(secretKeysDir, secretKeysSymlink)
  }
}

let staticSiteDat = null

function createStaticSiteDat (staticSiteDir) {
  const promise = new Promise((resolve, reject) => {
    Dat(staticSiteDir, (error, dat) => {
      if (error) {
        console.error('Error', error)
        return reject(error)
      }
      dat.joinNetwork(error => {
        if (error) {
          console.error('joinNetwork error (Static Site)', error)
          throw err
        }
        console.log('Network joined (Static Site)')
      })
      resolve(dat)
    })
  })
  return promise
}

async function share (staticSiteDir) {
  if (!argv['dat-share']) {
    return
  }
  console.log('Sharing Static Site', staticSiteDir)
  if (!staticSiteDat) {
    staticSiteDat = await createStaticSiteDat(staticSiteDir)
  }
  console.log(`Static site url: dat://${staticSiteDat.key.toString('hex')}/`)
}

async function publish (staticSiteDir) {
  if (!argv['dat-share']) {
    return
  }
  await share(staticSiteDir)
  /*
  const destOpts = {
    fs: staticSiteDat.archive,
    name: '/'
  }
  const progress = mirror(staticSiteDir, destOpts, function (error) {
    if (error) {
      console.error('Publish error', error)
      throw error
    }
    console.log('Published version', staticSiteDat.version)
  })
  */
  const opts = {
    equals: (src, dest, cb) => {
      // Hugo regenerates the files each time, so we ignore mtime
      const equals = (
        src.stat.isDirectory() ||
        src.stat.size === dest.stat.size
      )
      cb(null, equals)
    },
    ignoreDirs: false // Needed to make mirror-folder delete things
  }
  const importer = staticSiteDat.importFiles(opts, error => {
    if (error) {
      console.error('Publish error', error)
      throw error
    }
    console.log('Published version', staticSiteDat.version)
  })
}

async function run ({ sourceDatUrl, subscribe, share }) {
  setupDatSecretKeysSymlink()
  console.log('Source Url:', sourceDatUrl)
  const key = await datDns.resolveName(sourceDatUrl)
  console.log('Source Key:', key)
  const sourceDir = `${dataDir}/${key}/source`
  mkdirp.sync(sourceDir)
  const dat = await subscribeToDat(key)
  // networkTools(dat)
  datStatus(dat)
  const { archive } = dat
  // archiveTools(archive)
  watchForNewSyncedVersions(archive)
  // watchHistoryStream(archive)
  watchForUpdates(archive)
}

run({
  sourceDatUrl,
  subscribe: argv.subscribe,
  share: argv['dat-share']
})
