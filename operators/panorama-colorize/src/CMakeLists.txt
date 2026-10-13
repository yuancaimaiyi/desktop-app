cmake_minimum_required(VERSION 3.5.2)
project(panorama_colorize)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_BUILD_TYPE Release)

find_package(glim REQUIRED)
find_package(PCL 1.10 REQUIRED COMPONENTS common io filters kdtree search)
find_package(OpenCV 4 REQUIRED COMPONENTS core imgcodecs)

include_directories(${PCL_INCLUDE_DIRS} ${OpenCV_INCLUDE_DIRS})
link_directories(${PCL_LIBRARY_DIRS})
add_definitions(${PCL_DEFINITIONS})

add_executable(panorama_colorize panorama_colorize.cpp)
target_link_libraries(panorama_colorize
  glim::glim
  ${PCL_LIBRARIES}
  ${OpenCV_LIBS}
)
