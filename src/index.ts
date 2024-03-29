import Knex from 'knex'
import axios, { AxiosInstance } from 'axios'
import { createApp } from './adaptor'
import { KnexTransactionsService } from './services/transactions-service'
import { AccountLookupService } from './services/account-lookup-service'
import { createTcpRelay } from './tcp-relay'
import { KnexIsoMessageService } from './services/iso-message-service'
import { KnexQuotesService } from './services/quotes-service'
const HTTP_PORT = process.env.HTTP_PORT || 3000
const TCP_PORT = process.env.TCP_PORT || 3001
const ML_API_ADAPTOR_URL = process.env.ML_API_ADAPTOR_URL || 'http://ml-api-adaptor.local'
const TRANSACTION_REQUESTS_URL = process.env.TRANSACTION_REQUESTS_URL || 'http://transaction-requests.local'
const QUOTE_REQUESTS_URL = process.env.QUOTE_REQUESTS_URL || 'http://quote-requests.local'
const KNEX_CLIENT = process.env.KNEX_CLIENT || 'sqlite3'
const knex = KNEX_CLIENT === 'mysql' ? Knex({
  client: 'mysql',
  connection: {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  }
}) : Knex({
  client: 'sqlite3',
  connection: {
    filename: ':memory:',
    supportBigNumbers: true
  },
  useNullAsDefault: true
})

const transcationRequestClient = axios.create({
  baseURL: TRANSACTION_REQUESTS_URL,
  timeout: 3000
})
const transactionRequestService = new KnexTransactionsService(knex, transcationRequestClient)
const accountLookupClient: AxiosInstance = axios.create({
  baseURL: ML_API_ADAPTOR_URL,
  timeout: 3000
})
const accountLookupService = new AccountLookupService(accountLookupClient)
const isoMessagesService = new KnexIsoMessageService(knex)

const quotesClient: AxiosInstance = axios.create({
  baseURL: QUOTE_REQUESTS_URL,
  timeout: 3000
})
const quotesService = new KnexQuotesService(knex, quotesClient)

const start = async (): Promise<void> => {
  let shuttingDown = false
  console.log('LOG_LEVEL: ', process.env.LOG_LEVEL)
  if (KNEX_CLIENT === 'sqlite3') {
    console.log('in memory sqlite3 is being used. Running migrations....')
    await knex.migrate.latest()
    console.log('Migrations finished...')
  }

  const adaptor = await createApp({ transactionsService: transactionRequestService, accountLookupService, isoMessagesService, quotesService }, { port: HTTP_PORT })

  await adaptor.start()
  adaptor.app.logger.info(`Adaptor HTTP server listening on port:${HTTP_PORT}`)

  const relay = createTcpRelay('postillion', adaptor)
  relay.listen(TCP_PORT, () => { adaptor.app.logger.info(`Postillion TCP Relay server listening on port:${TCP_PORT}`) })

  process.on(
    'SIGINT',
    async (): Promise<void> => {
      try {
        if (shuttingDown) {
          console.warn(
            'received second SIGINT during graceful shutdown, exiting forcefully.'
          )
          process.exit(1)
        }

        shuttingDown = true

        // Graceful shutdown
        await adaptor.stop()
        relay.close()
        knex.destroy()
        console.log('completed graceful shutdown.')
      } catch (err) {
        const errInfo =
          err && typeof err === 'object' && err.stack ? err.stack : err
        console.error('error while shutting down. error=%s', errInfo)
        process.exit(1)
      }
    }
  )
}

start()
