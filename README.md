# INFUSIO-SIM LAB 3D

Banco universitario con bomba peristáltica y medición por pérdida de peso.
Interfaz blanca, manguera transparente y marcas azules que ilustran movimiento,
sin representar partículas añadidas. No hay hardware conectado.

## Uso

Abra index.html o ejecute `node preview.cjs` y visite http://127.0.0.1:8080/.
Three.js necesita conexión en la primera apertura.

Pulse START. La primera lectura de caudal aparece tras 30 segundos simulados;
seleccione 10× para acelerar la práctica. STOP detiene el motor.
El circuito inicia lleno. Vaciar y cebar muestra el llenado del tramo posterior
a la conexión de servicio: ese volumen no se suma al colector hasta llegar a él.
Tarar la balanza de salida no repone el depósito.

## Succión y medición

Los rodillos comprimen sucesivamente la manguera. Cuando liberan un tramo,
su recuperación elástica reduce la presión y permite aspirar desde la toma
sumergida. Se necesitan tubo apto para peristáltica y conexiones estancas.
El motor y el sensor de peso no tocan el líquido.

El depósito de 250 mL descansa sobre una celda de carga de 500 g, con tara
supuesta de 60 g. El HX711 simulado entrega 10 muestras/s de masa calibrada.
El firmware estima la pendiente por regresión de los últimos 30 s:
Q = −(dm/dt)/densidad. La balanza del colector comprueba la masa recogida.
Aspiración y entrega pueden diferir durante cebado, oclusión o una fuga física.

Monte la celda lejos del motor y deje el tubo holgado para evitar fuerzas
parásitas. Calibre cero y ganancia con masas conocidas, confirme la densidad
y respete la capacidad total incluyendo recipiente. El dibujo no es un plano
de fabricación.

## Modelo y límites

- Planta → hardware → firmware: el control recibe muestras HX711 y corriente,
  sin consultar el caudal verdadero. La interfaz sí muestra la verdad del modelo.
- Motor DC, PWM de 8 bits, desplazamiento peristáltico, presión, compliancia,
  depósito finito y recogida se integran con paso de 1 ms.
- La resolución de 0.01 g y el ruido son supuestos didácticos, no prestaciones
  garantizadas por un HX711. Se modelan gramos calibrados, no su protocolo.
- La ventana de 30 s introduce demora; no se garantiza exactitud clínica.
- No se calcula cavitación ni una altura máxima de aspiración validada.
  El tubo se dibuja sin deformación y el cebado no resuelve toda la física bifásica.
- El peso no detecta aire ni demuestra por sí solo entrega distal.
  Este prototipo didáctico no es un dispositivo para pacientes.
- Los modelos históricos óptico/Hall se conservan para regresión, fuera
  del circuito y los controles visibles actuales.

## Verificación

```
node tests/gravimetria.test.js
node tests/pagina.test.js
node tests/auditoria.test.js
node tests/fisica.test.js
node tests/recorrido.test.js
```

Cubren pendiente conocida, 600 s sin trazadores, pérdida de muestras,
reserva de depósito, cebado, conservación, interfaz y regresiones.
Los dos últimos archivos incluyen pruebas de sensores históricos.
La auditoría histórica está en AUDITORIA_LABORATORIO_2026-09-23.md;
este README describe el diseño gravimétrico vigente.
