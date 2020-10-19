import { startServer, connectRedis} from 'ilp-settlement-core'
import { creatEngine } from '.'

async function run() {
	const engine = creatEngine({
		xlmSecret: process.env.XLM_SECRET,
		stellarTestnetUrl: process.env.STELLAR_TESTNET_URL
	})
	
	const store = await connectRedis({
		uri: process.env.REDIS_URI,
		db: 1 // URI will override this
	})

	const { shutdown } = await startServer(engine, store, {
		connectorUrl: process.env.CONNECTER_URL,
		port: process.env.ENGINE_PORT
	})

	process.on('SIGINT', async () => {
		await shutdown()
		if (store.disconnect) {
			await store.disconnect()
		}
	})
}

run().catch(err => console.error(err))