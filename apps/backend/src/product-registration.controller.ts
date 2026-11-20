import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ProductRegistrationService } from "./product-registration.service";

@Controller("api/v1/product-registrations")
export class ProductRegistrationController {
  constructor(private readonly registrationService: ProductRegistrationService) {}

  @Post()
  register(@Body() body: unknown) {
    return this.registrationService.register(body);
  }

  @Get(":salesUnitId/edit")
  readEdit(@Param("salesUnitId") salesUnitId: string, @Query("storeId") storeId: string, @Query("date") date?: string) {
    return this.registrationService.readEdit(storeId, salesUnitId, date);
  }

  @Patch(":salesUnitId/edit")
  saveEdit(@Param("salesUnitId") salesUnitId: string, @Body() body: unknown) {
    return this.registrationService.saveEdit(salesUnitId, body);
  }
}
