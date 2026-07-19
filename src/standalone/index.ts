// Guard broken stdio before a dependency can write startup diagnostics.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EIO' && error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
      throw error
    }
  })
}

void import('./standalone-main')
