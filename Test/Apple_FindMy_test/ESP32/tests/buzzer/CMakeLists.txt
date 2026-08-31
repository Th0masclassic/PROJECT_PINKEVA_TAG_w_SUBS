cmake_minimum_required(VERSION 3.16)
project(pinkeva_buzzer_host_tests LANGUAGES CXX)
enable_testing()
find_package(Threads REQUIRED)

function(add_buzzer_test_binary name)
    add_executable(${name} test_buzzer.cpp ../../components/drivers/src/buzzer.cpp)
    target_compile_features(${name} PRIVATE cxx_std_20)
    target_include_directories(${name} PRIVATE stubs ../../components/drivers/include)
    target_link_libraries(${name} PRIVATE Threads::Threads)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(${name} PRIVATE -Wall -Wextra -Werror)
    endif()
endfunction()

add_buzzer_test_binary(buzzer_tests)
add_buzzer_test_binary(buzzer_no_pm_tests)
target_compile_definitions(buzzer_no_pm_tests PRIVATE CONFIG_PM_ENABLE=0)

foreach(binary IN ITEMS buzzer_tests buzzer_no_pm_tests)
    foreach(scenario IN ITEMS timing duplicate pause stale early concurrent stop_race
                              init_timer_config init_channel_config init_pause init_timer_create
                              start_frequency start_duty start_update start_resume start_timer stop_output)
        add_test(NAME ${binary}_${scenario} COMMAND ${binary} ${scenario})
        set_tests_properties(${binary}_${scenario} PROPERTIES TIMEOUT 10)
    endforeach()
endforeach()

foreach(scenario IN ITEMS init_apb_create init_awake_create start_apb_acquire start_awake_acquire)
    add_test(NAME buzzer_tests_${scenario} COMMAND buzzer_tests ${scenario})
endforeach()

foreach(pin IN ITEMS 34 0 2)
    add_buzzer_test_binary(buzzer_invalid_gpio_${pin})
    target_compile_definitions(buzzer_invalid_gpio_${pin} PRIVATE CONFIG_PINQEVA_BUZZER_GPIO=${pin})
    add_test(NAME buzzer_invalid_gpio_${pin} COMMAND buzzer_invalid_gpio_${pin} invalid_gpio)
endforeach()
