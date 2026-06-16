package com.inventoryiq;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * InventoryIQ — inventory & order management REST API.
 * Layered architecture: controller -> service -> repository -> database.
 */
@SpringBootApplication
public class InventoryIqApplication {
    public static void main(String[] args) {
        SpringApplication.run(InventoryIqApplication.class, args);
    }
}
