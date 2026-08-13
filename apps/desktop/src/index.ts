// Guard broken Electron stdio before the desktop host loads its dependencies.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EIO' && error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
      throw error
    }
  })
}

void import('./app-main')
