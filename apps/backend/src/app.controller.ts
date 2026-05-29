import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { AdsService } from "./ads.service";
import { CampaignMappingService } from "./campaign-mapping.service";
import { CostService } from "./cost.service";
import { CredentialService } from "./credential.service";
import { DatabaseService } from "./database.service";
import { FakePurchaseService } from "./fake-purchase.service";
import { MappingSeedService } from "./mapping-seed.service";
import { OrderMappingService } from "./order-mapping.service";
import { OrderSyncService } from "./order-sync.service";
import { OperationService } from "./operation.service";
import { ProfitService } from "./profit.service";
import { SalesUnitService } from "./sales-unit.service";
import { StoreService } from "./store.service";
import { formatApiSuccess } from "./helpers";

const normalizeFakePurchaseAmount = (value: number | string | null | undefined): number => {
  if (value == null || value === "") {
    return 0;
  }

  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new BadRequestException({
      success: false,
      message: "가구매 금액은 0 이상의 정수여야 합니다.",
      errors: [{ field: "amount", reason: "INVALID_AMOUNT" }],
    });
  }

  return Math.floor(amount);
};

@Controller("api/v1")
export class AppController {
  constructor(
    private readonly storeService: StoreService,
    private readonly credentialService: CredentialService,
    private readonly orderSyncService: OrderSyncService,
    private readonly salesUnitService: SalesUnitService,
    private readonly orderMappingService: OrderMappingService,
    private readonly adsService: AdsService,
    private readonly campaignMappingService: CampaignMappingService,
    private readonly costService: CostService,
    private readonly fakePurchaseService: FakePurchaseService,
    private readonly profitService: ProfitService,
    private readonly operationService: OperationService,
    private readonly mappingSeedService: MappingSeedService,
    private readonly databaseService: DatabaseService,
  ) {}

  @Get("health")
  health() {
    return formatApiSuccess({ ok: true, persistence: this.databaseService.getPersistenceStatus() });
  }

  @Get("stores")
  getStores() {
    return this.storeService.list();
  }

  @Post("stores")
  createStore(@Body() body: { name: string; sellerAccountId: string; channelNo: string; platformType?: "NAVER_SMARTSTORE" }) {
    return this.storeService.create(body);
  }

  @Patch("stores/:storeId")
  updateStore(@Param("storeId") storeId: string, @Body() body: { name: string; sellerAccountId: string; channelNo: string; memo?: string | null; deliveryUnitCost?: number }) {
    return this.storeService.update(storeId, body);
  }

  @Post("stores/:storeId/set-primary")
  setPrimary(@Param("storeId") storeId: string) {
    return this.storeService.setPrimary(storeId);
  }

  @Post("stores/:storeId/deactivate")
  deactivateStore(@Param("storeId") storeId: string) {
    return this.storeService.deactivate(storeId);
  }

  @Post("stores/:storeId/activate")
  activateStore(@Param("storeId") storeId: string) {
    return this.storeService.activate(storeId);
  }

  @Post("stores/:storeId/commerce-credentials")
  upsertCredentials(
    @Param("storeId") storeId: string,
    @Body() body: { clientId: string; clientSecret: string; accessType?: "SELLER" },
  ) {
    return this.credentialService.upsert(storeId, body);
  }

  @Get("stores/:storeId/commerce-credentials")
  getCredentials(@Param("storeId") storeId: string) {
    return this.credentialService.get(storeId);
  }

  @Post("stores/:storeId/commerce-credentials/test")
  testCredentials(@Param("storeId") storeId: string) {
    return this.credentialService.test(storeId);
  }

  @Post("stores/order-sync-all")
  orderSyncAll(@Body() body: { dateFrom?: string; dateTo?: string }) {
    return this.orderSyncService.enqueueSyncAll(body.dateFrom, body.dateTo);
  }

  @Post("stores/:storeId/order-sync")
  orderSync(
    @Param("storeId") storeId: string,
    @Body() body: { dateFrom?: string; dateTo?: string },
  ) {
    return this.orderSyncService.enqueueSync(storeId, body.dateFrom, body.dateTo);
  }

  @Get("order-items")
  getOrderItems(
    @Query("storeId") storeId: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("productName") productName?: string,
    @Query("optionInfo") optionInfo?: string,
    @Query("mappingStatus") mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT",
    @Query("orderStatus") orderStatus?: string,
    @Query("saleStatus") saleStatus?: string,
    @Query("paymentDateStatus") paymentDateStatus?: "ALL" | "PRESENT" | "MISSING",
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.orderSyncService.listOrderItems({
      storeId,
      dateFrom,
      dateTo,
      productName,
      optionInfo,
      mappingStatus,
      orderStatus,
      saleStatus,
      paymentDateStatus,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get("order-source-signatures")
  async getOrderSourceSignatures(
    @Query("storeId") storeId: string,
    @Query("mappingStatus") mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT",
    @Query("q") q?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.orderSyncService.listOrderSourceSignatures({
      storeId,
      mappingStatus,
      q,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post("order-source-signatures/:signatureId/mapping")
  saveOrderMapping(
    @Param("signatureId") signatureId: string,
    @Body() body:
      | { canonicalSalesUnitId: string }
      | {
          displayName: string;
          matchAliases?: string[] | null;
          memo?: string | null;
        },
  ) {
    if ("canonicalSalesUnitId" in body) {
      return this.orderMappingService.saveMapping(signatureId, body);
    }
    return this.orderMappingService.createAndMap(signatureId, body);
  }

  @Post("order-source-signatures/batch-mapping")
  saveOrderMappings(
    @Body() body:
      | { signatureIds: string[]; canonicalSalesUnitId: string }
      | {
          signatureIds: string[];
          displayName: string;
          matchAliases?: string[] | null;
          linkedProductIds?: string[] | null;
          linkedOptionCodes?: string[] | null;
          memo?: string | null;
        },
  ) {
    if ("canonicalSalesUnitId" in body) {
      return this.orderMappingService.saveMappings(body.signatureIds, body);
    }
    return this.orderMappingService.createAndMapMany(body.signatureIds, body);
  }

  @Post("stores/:storeId/order-mapping/recalculate")
  recalculateOrderMappings(@Param("storeId") storeId: string) {
    return this.orderMappingService.enqueueRecalculate(storeId);
  }

  @Post("mapping-seed/:storeId")
  async generateInitialMappingSeed(@Param("storeId") storeId: string) {
    const result = await this.mappingSeedService.generateInitialMappings(storeId);
    return formatApiSuccess(result);
  }

  @Get("canonical-sales-units")
  getSalesUnits(
    @Query("storeId") storeId: string,
    @Query("q") q?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.salesUnitService.list(storeId, q, page ? Number(page) : undefined, pageSize ? Number(pageSize) : undefined);
  }

  @Post("canonical-sales-units")
  createSalesUnit(@Body() body: { storeId: string; displayName: string; matchAliases?: string[] | null; linkedProductIds?: string[] | null; linkedOptionCodes?: string[] | null; memo?: string | null }) {
    return this.salesUnitService.create(body);
  }

  @Patch("canonical-sales-units/:salesUnitId")
  updateSalesUnit(
    @Param("salesUnitId") salesUnitId: string,
    @Body() body: { displayName: string; matchAliases?: string[] | null; linkedProductIds?: string[] | null; linkedOptionCodes?: string[] | null; memo?: string | null },
  ) {
    return this.salesUnitService.update(salesUnitId, body);
  }

  @Post("canonical-sales-units/:salesUnitId/deactivate")
  deactivateSalesUnit(@Param("salesUnitId") salesUnitId: string) {
    return this.salesUnitService.deactivate(salesUnitId);
  }

  @Post("canonical-sales-units/:salesUnitId/activate")
  activateSalesUnit(@Param("salesUnitId") salesUnitId: string) {
    return this.salesUnitService.activate(salesUnitId);
  }

  @Post("canonical-sales-units/group/create")
  createSalesUnitGroup(
    @Body() body: { storeId: string; displayName: string; childSalesUnitIds: string[] },
  ) {
    return this.salesUnitService.createSalesUnitGroup(body.storeId, body.displayName, body.childSalesUnitIds);
  }

  @Post("canonical-sales-units/group/:groupId/attach-child")
  attachChildToGroup(
    @Param("groupId") groupId: string,
    @Body() body: { storeId: string; childId: string },
  ) {
    return this.salesUnitService.attachChildToGroup(body.storeId, groupId, body.childId);
  }

  @Post("canonical-sales-units/group/:childId/detach-child")
  detachChildFromGroup(
    @Param("childId") childId: string,
    @Body() body: { storeId: string },
  ) {
    return this.salesUnitService.detachChildFromGroup(body.storeId, childId);
  }

  @Post("canonical-sales-units/group/:groupId/dissolve")
  dissolveGroup(
    @Param("groupId") groupId: string,
    @Body() body: { storeId: string },
  ) {
    return this.salesUnitService.dissolveGroup(body.storeId, groupId);
  }

  @Post("ad-uploads/preview")
  @UseInterceptors(FileInterceptor("file"))
  previewAdUpload(
    @UploadedFile() file: Express.Multer.File,
    @Body("storeId") storeId: string,
    @Body("reportDate") reportDate: string,
  ) {
    return this.adsService.previewUpload(storeId, reportDate, file);
  }

  @Get("ad-uploads/:uploadId/preview-rows")
  getPreviewRows(
    @Param("uploadId") uploadId: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.adsService.listPreviewRows(uploadId, page ? Number(page) : undefined, pageSize ? Number(pageSize) : undefined);
  }

  @Get("ad-uploads")
  getAdUploads(
    @Query("storeId") storeId: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.adsService.listUploads(storeId, page ? Number(page) : undefined, pageSize ? Number(pageSize) : undefined);
  }

  @Post("ad-uploads/:uploadId/confirm")
  confirmUpload(@Param("uploadId") uploadId: string) {
    return this.adsService.enqueueConfirm(uploadId);
  }

  @Delete("ad-uploads/:uploadId")
  deleteUpload(@Param("uploadId") uploadId: string) {
    return this.adsService.deleteUpload(uploadId);
  }

  @Get("ad-campaign-costs")
  getAdCampaignCosts(
    @Query("storeId") storeId: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("mappingStatus") mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT",
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.adsService.listAdCosts({
      storeId,
      dateFrom,
      dateTo,
      mappingStatus,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post("ad-campaign-costs/:adCostId/intentional-unmapped")
  setIntentionalUnmapped(@Param("adCostId") adCostId: string, @Body() body: { reasonNote: string }) {
    return this.adsService.setIntentionalUnmapped(adCostId, body);
  }

  @Post("ad-campaign-costs/batch-intentional-unmapped")
  setIntentionalUnmappedMany(@Body() body: { adCostIds: string[]; reasonNote: string }) {
    return this.adsService.setIntentionalUnmappedMany(body.adCostIds, body);
  }

  @Post("ad-campaign-costs/:adCostId/mapping")
  saveAdCampaignMapping(
    @Param("adCostId") adCostId: string,
    @Body() body: { canonicalSalesUnitId: string },
  ) {
    return this.adsService.saveManualMapping(adCostId, body);
  }

  @Post("ad-campaign-costs/batch-mapping")
  saveAdCampaignMappings(@Body() body: { adCostIds: string[]; canonicalSalesUnitId: string }) {
    return this.adsService.saveManualMappings(body.adCostIds, body);
  }

  @Post("ad-campaign-costs/:adCostId/recalculate-mapping")
  recalculateAdCampaignMapping(@Param("adCostId") adCostId: string) {
    return this.adsService.recalculateMapping(adCostId);
  }

  @Post("ad-campaign-costs/batch-recalculate-mapping")
  recalculateAdCampaignMappings(@Body() body: { adCostIds: string[] }) {
    return this.adsService.recalculateMappings(body.adCostIds);
  }

  @Get("ad-campaign-signatures")
  getAdCampaignSignatures(
    @Query("storeId") storeId: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("mappingStatus") mappingStatus?: "ALL" | "MAPPED" | "UNMAPPED" | "CONFLICT",
    @Query("q") q?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.adsService.listAdCampaignSignatures({
      storeId,
      dateFrom,
      dateTo,
      mappingStatus,
      q,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post("ad-campaign-signatures/batch-mapping")
  saveAdCampaignSignatureMappings(@Body() body: { signatureIds: string[]; canonicalSalesUnitId: string }) {
    return this.adsService.saveManualMappings(body.signatureIds, body);
  }

  @Post("ad-campaign-signatures/batch-intentional-unmapped")
  setAdCampaignSignaturesIntentionalUnmapped(@Body() body: { signatureIds: string[]; reasonNote: string }) {
    return this.adsService.setIntentionalUnmappedMany(body.signatureIds, body);
  }

  @Post("ad-campaign-signatures/batch-recalculate-mapping")
  recalculateAdCampaignSignatureMappings(@Body() body: { signatureIds: string[] }) {
    return this.adsService.recalculateMappings(body.signatureIds);
  }

  @Get("campaign-mappings")
  getCampaignMappings(
    @Query("storeId") storeId: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.campaignMappingService.list(storeId, page ? Number(page) : undefined, pageSize ? Number(pageSize) : undefined);
  }

  @Post("campaign-mappings")
  createCampaignMapping(@Body() body: { storeId: string; canonicalSalesUnitId: string; campaignPattern: string }) {
    return this.campaignMappingService.create(body);
  }

  @Patch("campaign-mappings/:mappingId")
  updateCampaignMapping(
    @Param("mappingId") mappingId: string,
    @Body() body: { canonicalSalesUnitId: string; campaignPattern: string },
  ) {
    return this.campaignMappingService.update(mappingId, body);
  }

  @Post("campaign-mappings/:mappingId/deactivate")
  deactivateCampaignMapping(@Param("mappingId") mappingId: string) {
    return this.campaignMappingService.deactivate(mappingId);
  }

  @Post("campaign-mappings/:mappingId/activate")
  activateCampaignMapping(@Param("mappingId") mappingId: string) {
    return this.campaignMappingService.activate(mappingId);
  }

  @Get("sales-unit-cost-settings")
  getCostSettings(
    @Query("storeId") storeId: string,
    @Query("canonicalSalesUnitId") canonicalSalesUnitId?: string,
  ) {
    return this.costService.list(storeId, canonicalSalesUnitId);
  }

  @Post("sales-unit-cost-settings")
  createCostSetting(
    @Body()
    body: {
      storeId: string;
      canonicalSalesUnitId: string;
      unitCost: number;
      feeRate: number | null;
      otherCost: number;
      effectiveFrom: string;
    },
  ) {
    return this.costService.create(body);
  }

  @Patch("sales-unit-cost-settings/:costSettingId")
  updateCostSetting(
    @Param("costSettingId") costSettingId: string,
    @Body() body: { unitCost: number; feeRate: number | null; otherCost: number; effectiveFrom: string },
  ) {
    return this.costService.update(costSettingId, body);
  }

  @Post("sales-unit-cost-settings/:costSettingId/close")
  closeCostSetting(@Param("costSettingId") costSettingId: string, @Body() body: { effectiveTo: string }) {
    return this.costService.close(costSettingId, body);
  }

  @Post("sales-unit-cost-settings/:costSettingId/deactivate")
  deactivateCostSetting(@Param("costSettingId") costSettingId: string) {
    return this.costService.deactivate(costSettingId);
  }

  @Post("sales-unit-cost-snapshots/import")
  @UseInterceptors(FileInterceptor("file"))
  async importCostSnapshot(
    @Body() body: { storeId: string; effectiveFrom: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.costService.importExcelSnapshot(body.storeId, body.effectiveFrom, file);
    return formatApiSuccess(result);
  }

  @Get("sales-unit-cost-snapshots")
  listCostSnapshots(
    @Query("storeId") storeId: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    const result = this.costService.listSnapshots(storeId, page ? Number(page) : undefined, pageSize ? Number(pageSize) : undefined);
    return formatApiSuccess(result);
  }

  @Get("sales-unit-cost-snapshots/export")
  exportCostSnapshot(
    @Query("storeId") storeId: string,
    @Res() res: Response,
    @Query("effectiveFrom") effectiveFrom?: string,
  ) {
    const buffer = this.costService.exportExcel(storeId, effectiveFrom);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=cost-snapshot-${storeId}-${effectiveFrom ?? "current"}.xlsx`,
    );
    res.setHeader("Content-Length", buffer.length.toString());
    res.end(buffer);
  }

  @Delete("sales-unit-cost-snapshots/:snapshotId")
  async deleteCostSnapshot(@Param("snapshotId") snapshotId: string) {
    const result = await this.costService.deleteSnapshot(snapshotId);
    return formatApiSuccess(result);
  }

  @Get("daily-fake-purchases")
  getDailyFakePurchase(
    @Query("storeId") storeId: string,
    @Query("date") date: string,
  ) {
    return formatApiSuccess(this.fakePurchaseService.get(storeId, date));
  }

  @Put("daily-fake-purchases")
  async upsertDailyFakePurchase(
    @Body() body: { storeId: string; date: string; amount?: number | string | null },
  ) {
    return formatApiSuccess(
      await this.fakePurchaseService.upsert({
        storeId: body.storeId,
        date: body.date,
        amount: normalizeFakePurchaseAmount(body.amount),
      }),
    );
  }

  @Get("dashboard/summary")
  getDashboardSummary(@Query("storeId") storeId: string, @Query("date") date: string) {
    return this.profitService.getDashboardSummary(storeId, date);
  }

  @Get("profits/latest-date")
  getLatestProfitDate(@Query("storeId") storeId: string) {
    return this.profitService.getLatestActivityDate(storeId);
  }

  @Get("profits/daily-sales-units")
  getDailySalesUnits(
    @Query("storeId") storeId: string,
    @Query("dateFrom") dateFrom: string,
    @Query("dateTo") dateTo: string,
    @Query("canonicalSalesUnitId") canonicalSalesUnitId?: string,
    @Query("includeGroupChildren") includeGroupChildren?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.profitService.listDailySalesUnits({
      storeId,
      dateFrom,
      dateTo,
      canonicalSalesUnitId,
      includeGroupChildren: includeGroupChildren === "true",
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get("profits/daily-sales-units/export")
  exportDailySalesUnits(
    @Query("storeId") storeId: string,
    @Query("dateFrom") dateFrom: string,
    @Query("dateTo") dateTo: string,
    @Res() res: Response,
    @Query("canonicalSalesUnitId") canonicalSalesUnitId?: string,
  ) {
    const buffer = this.profitService.exportDailySalesUnitsExcel({
      storeId,
      dateFrom,
      dateTo,
      canonicalSalesUnitId,
    });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=profit-daily-rows-${storeId}-${dateFrom}-${dateTo}.xlsx`,
    );
    res.setHeader("Content-Length", buffer.length.toString());
    res.end(buffer);
  }

  @Get("profits/daily-sales-units/:salesUnitId")
  getDailySalesUnitDetail(
    @Param("salesUnitId") salesUnitId: string,
    @Query("storeId") storeId: string,
    @Query("date") date: string,
  ) {
    return this.profitService.getDailySalesUnitDetail(storeId, salesUnitId, date);
  }

  @Get("profits/unmapped-summary")
  getUnmappedSummary(
    @Query("storeId") storeId: string,
    @Query("dateFrom") dateFrom: string,
    @Query("dateTo") dateTo: string,
  ) {
    return this.profitService.getUnmappedSummary(storeId, dateFrom, dateTo);
  }

  @Get("operations")
  getOperations(
    @Query("storeId") storeId: string,
    @Query("operationType") operationType?: "ORDER_SYNC" | "AD_UPLOAD_CONFIRM" | "RECALCULATE_ORDER_MAPPING" | "RECALCULATE_AD_MAPPING",
    @Query("status") status?: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED",
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.operationService.list(
      storeId,
      status,
      operationType,
      page ? Number(page) : undefined,
      pageSize ? Number(pageSize) : undefined,
    );
  }

  @Get("operations/:operationId")
  getOperation(@Param("operationId") operationId: string) {
    return this.operationService.get(operationId);
  }

  @Post("operations/:operationId/retry")
  retryOperation(@Param("operationId") operationId: string) {
    return this.operationService.retry(operationId);
  }
}
