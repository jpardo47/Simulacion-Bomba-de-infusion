# Auditoría de código y rediseño del laboratorio

Fecha: 23 de septiembre de 2026. Alcance: código local, geometría, interfaz, pruebas numéricas y verificación en navegador. No se contrastaron equipos físicos, hojas de datos ni normas; las conclusiones se refieren al simulador.

## Segunda revisión: visibilidad del flujo y prueba sostenida

Tras observar START durante más tiempo se identificó que no bastaba con cambiar la estética:

- El circuito inicia lleno y no mostraba ninguna señal visible de advección salvo burbujas muy claras. Ahora tiene marcas azules de movimiento ligadas a la integral de velocidad, manguera transparente (opacidad 0.16), trazador naranja, bomba azul, S1 rojo y S2 verde. Los colores se convierten de sRGB a iluminación lineal para conservar contraste.
- Se añadió un panel de recorrido con detecciones reales del hardware simulado, Δt, velocidad, masa, estado de cebado y reloj. Los modos 1×, 5× y 10× aceleran los pasos físicos, no solo el dibujo. Las marcas y las gotas no producen eventos de sensor ni determinan la masa.
- Se corrigió la entrega anticipada durante cebado: el volumen de transporte primero llena la longitud vacía y solo el excedente del paso se entrega al colector. La prueba comprueba conservación incluyendo el paso exacto de llegada. La presión hidrostática y las condiciones de contorno del punto 1 de límites siguen pendientes.
- El intervalo fijo de inyección de 9 s permitía varios trazadores simultáneos entre sensores. Ahora la inyección automática espera a que el anterior despeje S2. Las inyecciones manuales adicionales siguen disponibles y pueden introducir ambigüedad de emparejamiento: para una medida individual use una sola burbuja por tránsito.
- En la prueba de navegador apareció un falso timeout después de la primera medida. El PI integraba un error medio de tránsito durante todo el intervalo sin muestras, generando una corrección excesiva; además, 45 s no cubría el tránsito posterior a menor caudal. Se limita el paso de integración de cada corrección a 5 s y el timeout es el mayor entre 45 s y tres veces el tránsito nominal de la consigna. Son decisiones del controlador didáctico, no límites clínicos validados.
- STOP y rearme descartan el tránsito incompleto para que una pausa larga no dispare una alarma con tiempos anteriores. Purga y vaciado reinician también esa medida.
- `tests/recorrido.test.js` verifica cebado, conservación de volumen, una medida completa S1/S2, parada de marcas y 600 s de funcionamiento repetido a 120 mL/h. La prueba determinista obtuvo siete tránsitos por S2, sin alarmas de corte. En navegador se observó funcionamiento activo después de más de 690 s simulados, con medida de velocidad y masa positiva, sin errores de consola.

Esta sección actualiza los hallazgos y recuentos de la primera revisión conservada a continuación. La batería de regresión de entradas y estados tiene ahora nueve casos.

## Resultado

Se sustituyó la presentación oscura por un laboratorio de fondo blanco, texto oscuro, acentos azul sobrio y pantalla verde grisácea. Se reconstruyó el cabezal como una bomba peristáltica abierta de tres rodillos, con motor, reductora, ejes metálicos y rodillos marfil. La manguera ahora recorre el cabezal dentro de la misma trayectoria que usa la planta. El ángulo de giro sigue `Plant.st.anguloBomba`, calculado a partir de la velocidad del motor y la reductora.

La planta ya era peristáltica antes de esta revisión. El cambio consiste en corregir su representación y recorrido, conservar el modelo de desplazamiento positivo y corregir errores funcionales encontrados. La geometría se declara didáctica: no es un plano de fabricación y no calcula la deformación del tubo bajo cada rodillo.

## Hallazgos corregidos

| Prioridad | Evidencia anterior | Corrección y comprobación |
|---|---|---|
| Alta | `setSetpoint(NaN)` y otros setters admitían estados no finitos o geometría inválida. | Validación en la API; diámetro interior limitado por el exterior de 6 mm. Regresión con NaN, infinitos, negativos y diámetro excesivo. |
| Alta | El bolo admitía volumen o velocidad negativos; valores cero se sustituían silenciosamente por valores predeterminados. | Rechazo de dosis/ritmos no positivos y no finitos. El ritmo limitado es el que muestra y registra la interfaz. |
| Alta | Al completar VTBI durante un bolo, `caudalObjetivoMlMin()` seguía priorizando el bolo sobre KVO. | Se cancela el bolo antes de entrar en KVO. Regresión específica. |
| Alta | Un corte en KVO apagaba el PWM pero dejaba el modo KVO; la detección por corriente excluía KVO. | Transición a ALARMA y cancelación del bolo; evaluación por corriente también en KVO con PWM activo. Regresión del corte y del estado. La sensibilidad física de la detección requiere calibración. |
| Media | Cambiar de sensor conservaba corrección PI, tiempo de medida y alarma de turbina. | Reinicio de esas variables al cambiar sensor; se conservan las alarmas de corte hasta rearme. Regresión específica. |
| Media | `Ki = 0` era reemplazado por 0.35 mediante `valor || predeterminado`. | Cero permitido en Kp y Ki; los campos muestran el valor aceptado. |
| Media | El tubo visible cruzaba la bomba casi en línea recta y había un arco adicional sin continuidad hidráulica. | Trayectoria continua de nueve puntos sobre un arco de radio 21 mm; se elimina el arco duplicado. La ficha aislada añade el tramo de manguera correspondiente. |
| Media | El diámetro real cambiaba en la planta sin cambiar el radio del líquido dibujado. | Reconstrucción de la geometría interior cuando cambia el diámetro; liberación de la geometría anterior. |
| Media | Un fallo de inicialización WebGL detenía también el arranque de controles y física. | Captura del error de inicialización y mensaje de vista 3D no disponible; el resto del arranque continúa. Esta rama fue revisada en código, no se forzó un fallo del controlador gráfico real. |
| Media | Los interruptores con `display:none` desaparecían del recorrido por teclado. | Controles enfocables con indicador visible de foco; fondo y textos ajustados para tema claro. |
| Media | Pantalla: «presión de línea» e «infundido» sin explicar que la primera proviene de la planta y el segundo es estimado. | «Presión del modelo» y «Volumen estimado». También se distingue el muestreo simulado de una adquisición física. |
| Baja | STOP no publicaba salidas en cero hasta el siguiente paso de firmware. | Estado PWM/IN1/IN2 actualizado al pulsar STOP. La orquestación conserva su latencia documentada de un paso de 1 ms. |

## Límites y mejoras pendientes, por orden de importancia

1. **Balance hidráulico durante cebado y condiciones de contorno.** `plant.js` integra el volumen entregado independientemente de que el frente de cebado haya alcanzado la salida. Además, la presión hidrostática usa la diferencia entre cima y descarga (214−138 mm), sin modelar el nivel del depósito. Con mando cero la presión converge a esa referencia; el recorte de caudal inverso impide interpretar esto como una conservación global rigurosa. Para una práctica cuantitativa debe revisarse el balance de almacenamiento y las alturas de los extremos, con ensayos de conservación durante cebado, parada y liberación de oclusión.
2. **Depósito finito y tara.** El depósito se dibuja con `480 − desplazadoMl`, pero la planta no interrumpe el bombeo por agotamiento. `tararBalanza()` también reinicia contadores acumulados, lo que repone visualmente el depósito. Separar volumen físico del depósito y offset de tara antes de ensayos prolongados.
3. **Medida antigua y diagnóstico de ausencia de sensor.** El timeout óptico parte de una detección S1; no detecta por sí solo ausencia total de flancos. Una medida válida puede permanecer almacenada durante una parada. La integración de VI usa medida o consigna, no volumen verdadero. Añadir edad de medida, estado explícito «sin medida reciente» y ensayos de desconexión de ambos sensores.
4. **Rearme manual.** Se corrigió el comentario que afirmaba comprobar la desaparición de la causa: el rearme borra alarmas de corte y exige volver a iniciar, pero no demuestra que la pinza se haya retirado. No se presenta como enclavamiento físico validado.
5. **Parámetros y geometría efectiva.** Se mantienen radio volumétrico efectivo de 15 mm, radio visual del tubo de 21 mm, reducción 400:1 y coeficientes empíricos de fricción, fluencia, slip y trazadores. No se recalibraron para representar un modelo comercial. No confundir dimensiones de la escena con parámetros identificados experimentalmente.
6. **Pruebas y exactitud.** El ensayo físico existente contiene ruido aleatorio. Sus cifras cambian entre ejecuciones; en particular, estimar un LSB por diferencias instantáneas entre corridas mezcla cuantización y fase de pulsación. Promediar sobre vueltas completas y usar semillas reproducibles antes de afirmar un límite cuantitativo de exactitud. Las ocho pruebas nuevas de regresión usan semilla fija.
7. **Portabilidad.** Three.js y fuentes se cargan desde servicios externos. Para laboratorios sin Internet conviene distribuir una copia versionada de Three.js con su licencia; la tipografía ya tiene alternativa del sistema. No se ha creado un paquete offline.

## Verificaciones realizadas

- `node tests/auditoria.test.js`: 8 pruebas de regresión aprobadas.
- `node tests/pagina.test.js`: carga de 9 scripts, fotogramas, interacción con controles y consulta de 14 fichas sin errores, utilizando DOM y Three.js simulados. No sustituye una prueba WebGL real.
- `node tests/fisica.test.js`: 17 comprobaciones aprobadas. Salida conservada en `auditoria-fisica.log`; resultados numéricos sujetos al ruido del modelo.
- Navegador real: renderizado del banco, apertura/cierre de ficha de bomba, START/STOP y consulta de errores de consola. Se verificó la distribución de escritorio a 1440 px y estrecha a 390 px; en la vista estrecha el documento no desborda horizontalmente y el fondo computado es blanco.

No se han validado rendimiento en otros equipos, compatibilidad completa entre navegadores, conformidad normativa ni exactitud metrológica frente a un patrón físico.
> Actualización gravimétrica: el diseño vigente usa celda de carga de origen + HX711
> y balanza independiente de salida. Se retiraron de la escena los sensores ópticos,
> Hall y la inyección de trazadores. Las referencias a ese circuito en esta auditoría
> describen la revisión anterior; véase README.md para el funcionamiento actual.
> Verificación: 600 s sin trazadores, pendiente conocida, corte por falta de muestras
> y reserva de depósito, cebado y regresiones superadas. La resolución de peso y la
> succión son modelos didácticos; requieren calibración y validación del montaje real.

