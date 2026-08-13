// Guard broken stdio before the standalone Service loads its dependencies.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EIO' && error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
      throw error
    }
  })
}

void import('./standalone-main')
