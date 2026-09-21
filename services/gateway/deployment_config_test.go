package main

import "testing"

func TestMisspelledGatewayEnvironmentFailsClosed(t *testing.T) {
	for _, value := range []string{"prodution", "prod", "Production"} {
		t.Run(value, func(t *testing.T) {
			_, err := LoadEnv(func(key string) string {
				if key == "GATEWAY_ENV" {
					return value
				}
				return ""
			})
			if err == nil {
				t.Fatal("unknown environment bypassed production checks")
			}
		})
	}
}
