package com.inventoryiq.dto;

import jakarta.validation.constraints.*;
import java.math.BigDecimal;
import java.util.List;

/** Request/response payloads, with Bean Validation constraints. */
public class Dtos {

    public static class ProductRequest {
        @NotBlank public String name;
        @NotBlank public String sku;
        @NotNull @DecimalMin("0.0") public BigDecimal price;
        @NotNull @Min(0) public Integer stock;
    }

    public static class StockAdjustRequest {
        @NotNull public Integer delta;   // +ve to restock, -ve to remove
    }

    public static class OrderLine {
        @NotNull public Long productId;
        @NotNull @Min(1) public Integer quantity;
    }

    public static class OrderRequest {
        @NotBlank public String customer;
        @NotEmpty public List<@jakarta.validation.Valid OrderLine> items;
    }
}
