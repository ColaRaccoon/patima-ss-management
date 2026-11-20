import { Body, Controller, Get, Param, Put, Query } from "@nestjs/common";
import { ProductStatusService } from "./product-status.service";

@Controller("api/v1/product-registrations")
export class ProductStatusController {
  constructor(private readonly productStatusService: ProductStatusService) {}

  @Get("order-context")
  getOrderContext(
    @Query("storeId") storeId: string,
    @Query("signatureId") signatureIds?: string | string[],
  ) {
    return this.productStatusService.getOrderContext(storeId, signatureIds);
  }

  @Get("cost-coverage")
  getCostCoverage(@Query("storeId") storeId: string, @Query("date") date?: string) {
    return this.productStatusService.getCostCoverage(storeId, date);
  }

  @Get(":salesUnitId/status")
  getProductStatus(
    @Param("salesUnitId") salesUnitId: string,
    @Query("storeId") storeId: string,
    @Query("date") date?: string,
  ) {
    return this.productStatusService.getProductStatus(storeId, salesUnitId, date);
  }

  @Put(":salesUnitId/advertising")
  setAdvertisingStatus(
    @Param("salesUnitId") salesUnitId: string,
    @Body() body: { storeId?: string; notAdvertised?: boolean },
  ) {
    return this.productStatusService.setAdvertisingStatus(salesUnitId, body);
  }
}
