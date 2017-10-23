const Dat = require('dat-node')
const datDns = require('dat-dns')()
const minimist = require('minimist')
const mkdirp = require('mkdirp')
const { throttle, debounce } = require('lodash')
const PQueue = require('p-queue')

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
    const sourceDir = `data/${key}/source`
    mkdirp.sync(sourceDir)
    Dat(sourceDir, { key, sparse: true }, (error, dat) => {
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

let lastUpdateVersion = 0

const jobQueue = new PQueue({concurrency: 1})
const debounceDelay = 5

function watchForUpdates (archive) {
  const queueJob = debounce(() => {
    if (archive.version > lastUpdateVersion) {
      console.log('Update notice received, queuing job', archive.version)

      const genBuildJob = version => () => doFakeBuild(version)
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
  setTimeout(queueJob, 12000)
}

function doFakeBuild (version) {
  const promise = new Promise((resolve, reject) => {
    console.log('Building version', version)
    let counter = 0
    const intervalId = setInterval(() => {
      console.log('Counter', version, ++counter)
      if (counter >= 30) {
        console.log('Built version', version)
        clearInterval(intervalId)
        resolve()
      }
    }, 1000)
  })
  return promise
}

async function run ({ sourceDatUrl, subscribe, share }) {
  console.log('Source Url:', sourceDatUrl)
  const key = await datDns.resolveName(sourceDatUrl)
  console.log('Source Key:', key)
  const dat = await subscribeToDat(key)
  // networkTools(dat)
  datStatus(dat)
  const { archive } = dat
  // archiveTools(archive)
  watchForNewSyncedVersions(archive)
  // watchHistoryStream(archive)
  watchForUpdates(archive)
  // console.log('Jim', dat)
}

run({
  sourceDatUrl,
  subscribe: argv.subscribe,
  share: argv['dat-share']
})
