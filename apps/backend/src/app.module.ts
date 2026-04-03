import { Module } from "@nestjs/common";
import { AdsService } from "./ads.service";
import { AppController } from "./app.controller";
import { AuditLogService } from "./audit-log.service";
import { CampaignMappingService } from "./campaign-mapping.service";
import { CostService } from "./cost.service";
import { CredentialService } from "./credential.service";
import { CryptoService } from "./crypto.service";
import { DatabaseService } from "./database.service";
import { EnvironmentBootstrapService } from "./environment-bootstrap.service";
import { NaverCommerceConfigService } from "./naver-commerce-config.service";
import { NaverCommerceService } from "./naver-commerce.service";
import { OperationService } from "./operation.service";
import { OrderMappingService } from "./order-mapping.service";
import { OrderSyncService } from "./order-sync.service";
import { ProfitService } from "./profit.service";
import { SalesUnitService } from "./sales-unit.service";
import { StoreService } from "./store.service";

@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    DatabaseService,
    AuditLogService,
    CryptoService,
    NaverCommerceConfigService,
    NaverCommerceService,
    EnvironmentBootstrapService,
    OperationService,
    StoreService,
    CredentialService,
    SalesUnitService,
    OrderSyncService,
    OrderMappingService,
    AdsService,
    CampaignMappingService,
    CostService,
    ProfitService,
  ],
})
export class AppModule {}
