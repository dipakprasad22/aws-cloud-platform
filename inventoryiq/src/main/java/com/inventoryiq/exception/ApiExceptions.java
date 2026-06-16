package com.inventoryiq.exception;

public class ApiExceptions {

    /** Thrown when a referenced entity doesn't exist (-> HTTP 404). */
    public static class NotFoundException extends RuntimeException {
        public NotFoundException(String msg) { super(msg); }
    }

    /** Thrown when an order asks for more stock than is available (-> HTTP 409). */
    public static class InsufficientStockException extends RuntimeException {
        public InsufficientStockException(String msg) { super(msg); }
    }
}
