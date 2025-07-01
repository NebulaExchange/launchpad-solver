import { CacheService } from './services/cache.service';
import { CronService } from './services/cron.service';
import { DBService } from './services/db.service';
import { IntentsService } from './services/intents.service';
import { NearService } from './services/near.service';
import { QuoterService } from './services/quoter.service';
import { HttpService } from './services/http.service';
import { WebsocketConnectionService } from './services/websocket-connection.servce';

export async function app() {
  const cacheService = new CacheService('./data/cache.json');
  cacheService.loadFromDisk();

  const dbService = new DBService();
  await dbService.init();

  process.on('SIGINT', () => {
    cacheService.persistToDisk();
    process.exit();
  });
  process.on('SIGTERM', () => {
    cacheService.persistToDisk();
    process.exit();
  });

  const nearService = new NearService();
  await nearService.init();

  const intentsService = new IntentsService(nearService);

  const quoterService = new QuoterService(cacheService, dbService, nearService, intentsService);
  await quoterService.updateCurrentState();

  const cronService = new CronService(quoterService);
  cronService.start();

  const websocketService = new WebsocketConnectionService(quoterService, cacheService);
  websocketService.start();

  const httpService = new HttpService();
  httpService.start();
}
